import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-codex-guard-'))
const fakeCodex = path.join(temp, process.platform === 'win32' ? 'codex.exe' : 'codex')
const fixture = path.join(temp, 'fake-codex.cjs')
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    if (check()) return true
    await delay(25)
  }
  return false
}

before(() => {
  // A real Node process with Codex's executable name drives the actual launcher, never a model.
  fs.copyFileSync(process.execPath, fakeCodex)
  if (process.platform !== 'win32') fs.chmodSync(fakeCodex, 0o755)
  const main = async () => {
    const fs = require('node:fs'), { spawn } = require('node:child_process')
    const spec = JSON.parse(process.env.HANDS_GUARD_FIXTURE)
    fs.writeFileSync('parent.pid', String(process.pid))
    if (spec.descendants) {
      const grandchild = "require('node:fs').writeFileSync('grandchild.pid', String(process.pid));setInterval(()=>{},1000)"
      const child = `require('node:fs').writeFileSync('child.pid', String(process.pid));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000)`
      spawn(process.execPath, ['-e', child], { stdio: 'ignore', windowsHide: true })
      while (!fs.existsSync('grandchild.pid')) await new Promise(r => setTimeout(r, 10))
    }
    const bytes = Buffer.from(spec.output)
    // Split a UTF-8 character across chunks, and allow a final JSON event without a newline.
    const split = bytes.indexOf(Buffer.from('中')) + 1 || Math.floor(bytes.length / 2)
    fs.writeFileSync('emitted-at.txt', String(Date.now()))
    process.stdout.write(bytes.subarray(0, split))
    await new Promise(r => setTimeout(r, 15))
    process.stdout.write(bytes.subarray(split))
    if (spec.hang) {
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
    } else process.exitCode = spec.exitCode || 0
  }
  fs.writeFileSync(fixture, `(${main.toString()})().catch(error => { console.error(error); process.exitCode = 1 })`)
})
after(() => fs.rmSync(temp, { recursive: true, force: true }))

async function run(name, spec, { guarded = true, json = true } = {}) {
  const directory = path.join(temp, name)
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'launch.json'), JSON.stringify({ command: guarded ? fakeCodex : process.execPath, args: [fixture, ...(json ? ['--json'] : [])], cwd: directory }))
  const started = Date.now()
  const child = spawn(process.execPath, [runner, directory, 'fixture only'], { env: { ...process.env, HANDS_GUARD_FIXTURE: JSON.stringify(spec) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  let allExited = false
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Runner failed to stop within 10 seconds')) }, 10000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => { clearTimeout(timer); resolve(code) })
    })
    const pids = ['parent', 'child', 'grandchild'].map(label => path.join(directory, `${label}.pid`)).filter(file => fs.existsSync(file)).map(file => Number(fs.readFileSync(file)))
    assert.ok(await until(() => pids.every(pid => !alive(pid))), 'launcher must end the whole fixture process tree')
    allExited = true
    const emitted = path.join(directory, 'emitted-at.txt')
    const reactionMs = fs.existsSync(emitted) ? Date.now() - Number(fs.readFileSync(emitted)) : null
    const result = { code, stdout, stderr, elapsedMs: Date.now() - started, reactionMs, pids, allExited, modelCalls: 0 }
    if (process.env.HANDS_GUARD_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.HANDS_GUARD_EVIDENCE_DIR, { recursive: true })
      fs.writeFileSync(path.join(process.env.HANDS_GUARD_EVIDENCE_DIR, name + '.json'), JSON.stringify(result, null, 2) + '\n')
    }
    console.log(`${name}: exit=${code}; fixture pids=${pids.join(',') || '(not started)'}; all exited; reaction=${reactionMs} ms; model calls=0`)
    return result
  } finally {
    // Only fixture-owned PIDs can be cleaned up if an assertion fails.
    if (!allExited) for (const label of ['grandchild', 'child', 'parent']) {
      try { process.kill(Number(fs.readFileSync(path.join(directory, label + '.pid'))), 'SIGKILL') } catch {}
    }
  }
}

test('Codex local command event stops its parent, child and grandchild immediately', { timeout: 20000 }, async () => {
  const result = await run('local-command', { output: JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'echo 中文 harmless', status: 'in_progress' } }) + '\n', hang: true, descendants: true })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /item.started\/command_execution.*echo 中文 harmless/)
  assert.equal(result.pids.length, 3)
  assert.ok(result.reactionMs < 5000)
})

test('Codex patch completion without a trailing newline is still stopped and names every file', { timeout: 20000 }, async () => {
  const result = await run('local-patch', { output: JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'src/中文.ts', kind: 'update' }, { path: 'old.txt', kind: 'delete' }], status: 'completed' } }) })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /item.completed\/file_change.*src\/中文.ts.*old.txt/)
})

test('hands MCP events and text mentioning local tool names pass through unchanged', { timeout: 20000 }, async () => {
  const output = [
    { type: 'thread.started', thread_id: 'fixture' },
    { type: 'item.started', item: { id: 'item_3', type: 'mcp_tool_call', server: 'hands', tool: 'run_command', arguments: { command: 'echo 中文; # exec_command apply_patch' } } },
    { type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'hands', tool: 'read_file', result: { content: [{ type: 'text', text: '{"type":"command_execution"}' }], structured_content: { type: 'file_change' } }, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'No command_execution or file_change was used.' } },
    { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } },
  ].map(event => JSON.stringify(event)).join('\r\n') + '\r\n'
  const result = await run('hands-only', { output })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, output)
  assert.equal(result.stderr, '')
})

test('broken JSON stream stops rather than silently disabling Codex monitoring', { timeout: 20000 }, async () => {
  const result = await run('invalid-json', { output: 'not a JSON event\n', hang: true })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /invalid JSON event stream/)
})

test('Codex configuration without JSON output is rejected before launching', { timeout: 20000 }, async () => {
  const result = await run('missing-json', { output: '' }, { json: false })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /requires --json/)
  assert.deepEqual(result.pids, [])
})

test('ordinary Codex failure retains its nonzero exit code', { timeout: 20000 }, async () => {
  const result = await run('upstream-failure', { output: '{"type":"turn.failed","error":{"message":"fixture"}}\n', exitCode: 7 })
  assert.equal(result.code, 7)
  assert.equal(result.stderr, '')
})

test('non-Codex launchers retain their original output behavior', { timeout: 20000 }, async () => {
  const output = '{"type":"item.started","item":{"type":"command_execution"}}\n'
  const result = await run('other-agent', { output }, { guarded: false })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, output)
  assert.equal(result.stderr, '')
})
