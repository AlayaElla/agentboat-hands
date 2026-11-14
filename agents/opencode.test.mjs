import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// Opt in with a previously installed executable; this never installs software or calls a model.
test('OpenCode loads generated local config, registers hands tools and denies native file/command permissions', {
  skip: !process.env.HANDS_TEST_OPENCODE_BIN, timeout: 45000,
}, async () => {
  const executable = process.env.HANDS_TEST_OPENCODE_BIN
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-opencode-check-'))
  const root = path.join(temp, 'remote 中文'), host = path.join(temp, 'host')
  fs.mkdirSync(root)
  const password = randomBytes(32).toString('base64url') // Ephemeral loopback-server auth only; never stored or printed.
  const env = { ...process.env, OPENCODE_PASSWORD: password, XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_DATA_HOME: path.join(temp, 'data'), XDG_CACHE_HOME: path.join(temp, 'cache'), XDG_STATE_HOME: path.join(temp, 'state') }
  execFileSync(process.execPath, [fileURLToPath(new URL('./generate.mjs', import.meta.url)), '--agent', 'opencode', '--local', '--root', root, '--out', host], { env, windowsHide: true })
  const child = spawn(executable, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0', '--print-logs'], { env, cwd: host, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  let logs = ''
  child.stderr.on('data', data => { logs = (logs + data).slice(-30000) })
  const lines = createInterface({ input: child.stdout })
  try {
    const handshake = await Promise.race([
      new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
      exited.then(code => { throw new Error(`OpenCode exited ${code} before startup`) }),
    ])
    const base = new URL(handshake.url)
    const headers = { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') }
    base.username = base.password = ''
    const query = new URLSearchParams({ 'location[directory]': host })
    const api = async (route, body) => {
      const response = await fetch(new URL(route, base), { headers: { ...headers, 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) })
      assert.equal(response.status, 200, await response.clone().text())
      return response.json()
    }
    let server
    for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
      server = (await api(`/api/mcp?${query}`)).data.find(s => s.name === 'hands')
      if (server?.status.status === 'connected') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(server?.status.status, 'connected', 'MCP discovery is asynchronous; wait for connected rather than trusting the initial empty list')
    const agent = (await api(`/api/agent?${query}`)).data.find(a => a.id === 'hands')
    assert.equal(agent.mode, 'primary')
    const { data: session } = await api('/api/session', { agent: 'hands', location: { directory: host } })
    const decisions = {}
    for (const action of ['read', 'edit', 'glob', 'grep', 'shell', 'subagent', 'hands_read_file', 'hands_run_command']) {
      const resources = [action === 'shell' ? 'echo native-command-must-not-run' : path.join(host, 'native-file-must-not-open.txt')]
      const { data } = await api(`/api/session/${session.id}/permission`, { action, resources, agent: 'hands' })
      decisions[action] = data.effect
      assert.equal(data.effect, action.startsWith('hands_') ? 'allow' : 'deny', action)
    }
    assert.match(logs, /mcp connected[^\n]*server=hands[^\n]*tools=16/)
    const report = { version: execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), transport: 'generated --local config through real OpenCode MCP client', server, toolCount: 16, agent: agent.id, decisions, modelCalls: 0, boundary: 'real permission evaluation, not a model-generated tool execution', isolatedPaths: { config: env.XDG_CONFIG_HOME, data: env.XDG_DATA_HOME, cache: env.XDG_CACHE_HOME, state: env.XDG_STATE_HOME } }
    if (process.env.HANDS_OPENCODE_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.HANDS_OPENCODE_EVIDENCE_DIR, { recursive: true })
      fs.writeFileSync(path.join(process.env.HANDS_OPENCODE_EVIDENCE_DIR, 'integration.json'), JSON.stringify(report, null, 2) + '\n')
    }
    console.log(JSON.stringify(report))
  } finally {
    // --stdio owns its server lifetime: closing stdin shuts down OpenCode and its MCP children.
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 5000)
    await exited.finally(() => clearTimeout(timer))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
