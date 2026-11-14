#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadProjectSkills, snapshotFiles } from './project-skills.mjs'

const ps = value => "'" + value.replace(/['‘’‚‛]/g, '$&$&') + "'"
const toml = value => JSON.stringify(value) // JSON strings and arrays are also TOML basic strings/arrays.
const clean = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value)

// hands defaults to this checkout, which is right for --local; over SSH it is a path on the other machine, so pass it.
export function transport({ ssh, root, hands = fileURLToPath(new URL('../hands.mjs', import.meta.url)), pdfPython, local = false }) {
  for (const value of [root, hands]) if (!clean(value)) throw new Error('root and hands must be nonempty paths without control characters.')
  if (local) return { command: process.execPath, args: [path.resolve(hands), path.resolve(root)], ...(pdfPython ? { env: { HANDS_PDF_PYTHON: pdfPython } } : {}) }
  if (!clean(ssh) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:\[\]-]*$/.test(ssh)) throw new Error('ssh must be a host alias or user@host, never options or a command.')
  for (const value of [root, hands, ...(pdfPython ? [pdfPython] : [])]) {
    if (!clean(value) || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(value)) throw new Error('Remote paths must be absolute Windows paths. Pass --hands with the location of hands.mjs on the remote machine.')
  }
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; " +
    (pdfPython ? `$env:HANDS_PDF_PYTHON=${ps(pdfPython)}; ` : '') + `& node ${ps(hands)} ${ps(root)}; exit $LASTEXITCODE`
  return { command: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '--', ssh,
    'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64')] }
}

export function generate({ agent, root, server, model, directory, snapshot = { revision: null, skills: [] } }) {
  if (!['claude', 'codex', 'opencode'].includes(agent)) throw new Error('agent must be claude, codex or opencode.')
  const instructions = `Project files, commands and desktop are on the hands machine, root ${root}. Use only hands MCP tools for all project work. Never use host shell, exec_command, apply_patch, local project file/search, browser/computer, native skill tools or subagents. Reviewed project skill instructions are supplied in the task/configuration; apply them when relevant, but execute their scripts and read supporting files only through hands at the stated source paths. If hands fails, stop and report; never fall back locally. Read PDFs with read_file pdf_format=text if documents cannot be opened. Commands are not sandboxed on hands; stay in the assigned root.` + (agent === 'claude' ? ' You may use built-in Read only on ~/.claude/projects/** to open PDF attachments cached by Claude Code; never read other host paths.' : '')
  const files = { 'remote-only.md': instructions + '\n', ...snapshotFiles(snapshot, root) }
  let args, notes = []
  if (agent === 'claude') {
    files['mcp.json'] = JSON.stringify({ mcpServers: { hands: server } }, null, 2) + '\n'
    args = ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
      '--mcp-config', path.join(directory, 'mcp.json'), '--tools', 'Read', '--disable-slash-commands', '--permission-mode', 'default',
      '--allowedTools', 'mcp__hands', 'Read(~/.claude/projects/**)', '--disallowedTools', 'Bash,PowerShell,Edit,Write,Glob,Grep,NotebookEdit,Agent',
      '--append-system-prompt', instructions]
    notes.push('Built-in Read is retained only for Claude PDF cache permissions; all project operations use hands. Other local Read requests are not preapproved.')
  } else if (agent === 'codex') {
    const config = {
      approval_policy: 'never', sandbox_mode: 'read-only', 'windows.sandbox': 'unelevated', 'features.prefer_mxc': false,
      'features.shell_tool': false, 'features.unified_exec': false, 'features.apps': false, 'features.plugins': false,
      'features.multi_agent': false, 'features.computer_use': false, 'features.browser_use': false, 'features.hooks': false,
      web_search: 'disabled', project_doc_max_bytes: 0, developer_instructions: instructions,
      'mcp_servers.hands.command': server.command, 'mcp_servers.hands.args': server.args,
      'mcp_servers.hands.default_tools_approval_mode': 'approve', 'mcp_servers.hands.required': true,
      ...(server.env ? { 'mcp_servers.hands.env': server.env } : {}),
    }
    // TOML inline tables need key=value, unlike JSON objects.
    const value = v => v && !Array.isArray(v) && typeof v === 'object'
      ? '{' + Object.entries(v).map(([k, x]) => `${k}=${toml(x)}`).join(',') + '}' : toml(v)
    args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', ...Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${value(v)}`])]
    notes.push('Codex built-in execution and patch tools cannot be reliably removed by these flags. Read-only host sandbox + developer instructions are defense in depth, not strict isolation; use a disposable host OS/container for a hard boundary. Never enable elevated Windows sandbox for this launch.')
  } else {
    const permissions = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'hands_*', resource: '*', effect: 'allow' }]
    files['opencode.json'] = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { servers: { hands: { type: 'local', command: [server.command, ...server.args], codemode: false, ...(server.env ? { environment: server.env } : {}) } } },
      permissions, default_agent: 'hands', agents: { hands: { mode: 'primary', system: instructions, permissions } },
      instructions: [path.join(directory, 'remote-only.md'), ...(snapshot.skills.length ? [path.join(directory, 'project-skills.md')] : [])], ...(model ? { model } : {}),
    }, null, 2) + '\n'
    args = ['run', '--standalone']
    notes.push('Validated with OpenCode 2.3.0: generated local MCP connects and registers all 16 hands tools; native read/edit/glob/grep/shell permissions are denied. Model access still needs an available free quota or a provider connected by the user. Start from this isolated directory; managed policies still apply.')
  }
  if (model) args.push('--model', model)
  return { files, launch: { command: agent, args, cwd: directory, notes,
    ...(snapshot.skills.length && agent !== 'opencode' ? { promptFile: path.join(directory, 'project-skills.md') } : {}) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { agent: { type: 'string' }, ssh: { type: 'string' }, root: { type: 'string' }, hands: { type: 'string' }, out: { type: 'string' }, model: { type: 'string' }, 'pdf-python': { type: 'string' }, local: { type: 'boolean' } } })
    if (!values.out) throw new Error('Usage: node generate.mjs --agent claude|codex|opencode --ssh user@windows --root D:/project --out <new-directory> [--hands D:/tools/agentboat-hands/hands.mjs] [--model name] [--pdf-python D:/venv/Scripts/python.exe]. --local is only for same-machine tests.')
    const directory = path.resolve(values.out)
    const server = transport({ ...values, pdfPython: values['pdf-python'] })
    const snapshot = loadProjectSkills({ ...values, server })
    const result = generate({ ...values, directory, server, snapshot })
    fs.mkdirSync(directory) // refuse existing directories, never overwrite a configuration
    for (const [name, content] of Object.entries(result.files)) {
      fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true })
      fs.writeFileSync(path.join(directory, name), content, { flag: 'wx' })
    }
    fs.writeFileSync(path.join(directory, 'launch.json'), JSON.stringify(result.launch, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ directory, ...result.launch }, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
