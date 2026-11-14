import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { generate, transport } from './generate.mjs'
import { client } from './mcp-client.mjs'

test('Windows remote paths survive macOS argv and PowerShell quoting, without shell injection', () => {
  const root = "D:/项目/boat '$x; (one) & two"
  const server = transport({ ssh: 'boat@windows', root, hands: "D:/Agent Boat/hands.mjs", pdfPython: 'D:/PDF Python/python.exe' })
  assert.equal(server.command, 'ssh')
  assert.ok(server.args.includes('BatchMode=yes') && server.args.includes('StrictHostKeyChecking=yes'))
  const script = Buffer.from(server.args.at(-1).split(' ').at(-1), 'base64').toString('utf16le')
  assert.match(script, /& node 'D:\/Agent Boat\/hands.mjs' 'D:\/项目\/boat ''\$x; \(one\) & two'/)
  assert.match(script, /HANDS_PDF_PYTHON='D:\/PDF Python\/python.exe'/)
  for (const ssh of ['-oProxyCommand=evil', 'host;evil', 'host\ncommand', 'host space']) assert.throws(() => transport({ ssh, root }))
  for (const root of ['relative/path', 'C:relative', 'D:/project\nexit']) assert.throws(() => transport({ ssh: 'host', root }))
})

test('all generated clients preapprove only hands; Codex host stays read-only and unelevated', () => {
  const server = transport({ ssh: 'boat@windows', root: 'D:/project', hands: 'D:/hands/hands.mjs' })
  for (const agent of ['claude', 'codex', 'opencode']) {
    const { files, launch } = generate({ agent, root: 'D:/project', server, directory: '/tmp/boat session' })
    assert.match(files['remote-only.md'], /never fall back locally/)
    assert.equal(launch.command, agent)
    assert.ok(!launch.args.some(arg => /dangerously|bypassPermissions|elevated"/.test(arg) && !arg.includes('unelevated')))
    if (agent === 'claude') {
      assert.deepEqual(JSON.parse(files['mcp.json']).mcpServers.hands, server)
      assert.ok(launch.args.includes('--strict-mcp-config') && launch.args.includes('mcp__hands'))
    } else if (agent === 'codex') {
      assert.ok(launch.args.includes('sandbox_mode="read-only"') && launch.args.includes('windows.sandbox="unelevated"'))
      assert.ok(launch.args.includes('mcp_servers.hands.default_tools_approval_mode="approve"'))
      assert.match(launch.notes.join(''), /not strict isolation/)
    } else {
      const config = JSON.parse(files['opencode.json'])
      assert.equal(config.mcp.servers.hands.codemode, false)
      assert.equal(config.default_agent, 'hands')
      assert.deepEqual(config.agents.hands.permissions, config.permissions)
      assert.deepEqual(config.permissions, [{ action: '*', resource: '*', effect: 'deny' }, { action: 'hands_*', resource: '*', effect: 'allow' }])
    }
  }
})

test('CLI writes portable files and refuses to overwrite an existing directory', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-config-'))
  const directory = path.join(temp, 'config')
  const args = [fileURLToPath(new URL('./generate.mjs', import.meta.url)), '--agent', 'claude', '--root', 'D:/test', '--ssh', 'user@win', '--hands', 'D:/hands/hands.mjs', '--out', directory]
  try {
    execFileSync(process.execPath, args)
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'launch.json'))).cwd, directory)
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }))
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('launcher preserves empty arguments, Unicode, spaces and embedded quotes without a shell', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-launch-'))
  const values = ['', 'a="one two"', '中文 $x; & (three)', "it's literal"]
  try {
    fs.writeFileSync(path.join(directory, 'launch.json'), JSON.stringify({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...values], cwd: directory }))
    const result = execFileSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), directory, 'prompt'], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(result), [...values, 'prompt'])
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('encoded Windows SSH command preserves MCP stdin/stdout and Chinese through PowerShell', { skip: process.platform !== 'win32' }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-encoded-'))
  const root = path.join(temp, "中文 space 'quote' & $x")
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'utf8.txt'), '中文 stdio')
  const server = transport({ ssh: 'unused-host', root, hands: fileURLToPath(new URL('../hands.mjs', import.meta.url)) })
  const service = client({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', server.args.at(-1).split(' ').at(-1)] })
  try {
    assert.equal((await service.rpc('initialize', {})).result.serverInfo.name, 'agentboat-hands')
    assert.equal((await service.call('read_file', { path: 'utf8.txt' })).text, '中文 stdio')
  } finally { await service.close(); fs.rmSync(temp, { recursive: true, force: true }) }
})
