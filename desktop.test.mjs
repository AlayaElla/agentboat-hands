import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { callDesktop, desktopTools, validateDesktop } from './desktop.mjs'
import { startAgent } from './desktop-agent.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const win = process.platform === 'win32'
const inputEnabled = process.env.HANDS_TEST_INPUT === '1'
const evidence = path.resolve(process.env.HANDS_EVIDENCE_DIR || path.join(here, 'evidence'))
const delay = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 10000) {
  const end = Date.now() + ms
  do { try { const value = await fn(); if (value) return value } catch {} await delay(100) } while (Date.now() < end)
  throw new Error('Timed out waiting for the test fixture.')
}
function mcp(directory) {
  const child = spawn(process.execPath, [path.join(here, 'hands.mjs'), here], { env: { ...process.env, HANDS_DESKTOP_DIR: directory }, stdio: ['pipe', 'pipe', 'inherit'] })
  let id = 0, buffer = ''; const pending = new Map()
  child.stdout.on('data', c => {
    buffer += c
    for (let n; (n = buffer.indexOf('\n')) >= 0;) {
      const msg = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1)
      pending.get(msg.id)?.(msg.result); pending.delete(msg.id)
    }
  })
  return { child, call: (name, args = {}) => new Promise((resolve, reject) => {
    const current = ++id
    const timer = setTimeout(() => { pending.delete(current); reject(new Error('MCP call timed out; not retrying.')) }, 25000)
    pending.set(current, r => { clearTimeout(timer); resolve(r) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method: 'tools/call', params: { name, arguments: args } }) + '\n')
  }) }
}
const text = r => r.content?.filter(c => c.type === 'text').map(c => c.text).join('')
const value = r => { assert.equal(r.isError, undefined, text(r)); return JSON.parse(text(r)) }
function saveImage(result, name) {
  const meta = value(result); const image = result.content.find(c => c.type === 'image')
  assert.equal(image.mimeType, 'image/png')
  const data = Buffer.from(image.data, 'base64')
  assert.ok(data.length <= 3500000)
  assert.equal(data.readUInt32BE(16), meta.imageWidth); assert.equal(data.readUInt32BE(20), meta.imageHeight)
  assert.equal(meta.scaleX, meta.imageWidth / meta.bounds.width); assert.equal(meta.scaleY, meta.imageHeight / meta.bounds.height)
  if (name) fs.writeFileSync(path.join(evidence, name), data)
  return meta
}

test('desktop validation rejects unsafe or ambiguous arguments before any backend input', () => {
  const invalid = [
    ['desktop_screenshot', { target: 'window' }], ['desktop_screenshot', { target: 'monitor', monitor: -1 }],
    ['desktop_screenshot', { target: 'region', x: 0, y: 0, width: 0, height: 10 }], ['desktop_screenshot', { max_dimension: 1 }],
    ['desktop_screenshot', { target: 'desktop', window_id: '123' }], ['desktop_focus', { window_id: '1;exit' }],
    ['desktop_mouse', { window_id: '123', action: 'click', x: NaN, y: 0 }], ['desktop_mouse', { window_id: '123', action: 'drag', x: 1, y: 2 }],
    ['desktop_mouse', { window_id: '123', action: 'scroll', x: 1, y: 2, delta: 0 }],
    ['desktop_type', { window_id: '123', text: '' }], ['desktop_type', { window_id: '123', text: 'x\0y' }],
    ['desktop_key', { window_id: '123', keys: ['CTRL', 'ctrl'] }], ['desktop_key', { window_id: '123', keys: ['unknown'] }],
    ['desktop_displays', { extra: true }], ['run_command', { command: 'x' }],
  ]
  for (const [name, args] of invalid) assert.throws(() => validateDesktop(name, args), `${name}: ${JSON.stringify(args)}`)
  for (const [name, args] of [
    ['desktop_screenshot', { target: 'region', x: -1920, y: -40, width: 100, height: 100 }],
    ['desktop_mouse', { window_id: '123', action: 'click', button: 'right', x: -100, y: 5 }],
    ['desktop_mouse', { window_id: '123', action: 'double_click', x: 1, y: 2 }],
    ['desktop_mouse', { window_id: '123', action: 'drag', x: -10, y: 2, to_x: 20, to_y: 50, duration_ms: 100 }],
    ['desktop_mouse', { window_id: '123', action: 'scroll', x: 1, y: 2, delta: -120, axis: 'horizontal' }],
    ['desktop_type', { window_id: '123', text: '中文🛶\n' }], ['desktop_key', { window_id: '123', keys: ['CTRL', 'SHIFT', 'A'] }],
  ]) assert.equal(validateDesktop(name, args), args)
})

test('macOS and Linux desktop calls explicitly report not supported', async () => {
  for (const platform of ['darwin', 'linux']) for (const name of Object.keys(desktopTools)) await assert.rejects(callDesktop(name, {}, { platform }), /暂不支持/)
})

test('missing desktop agent gives a startup instruction, never falls back to SSH input', async () => {
  await assert.rejects(callDesktop('desktop_displays', {}, { platform: 'win32', directory: path.join(os.tmpdir(), `hands-missing-${process.pid}`) }), /start-desktop.ps1/)
})

test('loopback agent authenticates, validates, serializes and returns MCP images (fake input only)', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-agent-unit-'))
  let release; const calls = []
  const backend = { call: async (name, args) => {
    calls.push({ name, args })
    if (name === 'desktop_type') await new Promise(r => { release = r })
    if (name === 'desktop_screenshot') return { data: 'YWJj', bounds: { x: -100, y: 0, width: 100, height: 50 }, imageWidth: 50, imageHeight: 25, scaleX: 0.5, scaleY: 0.5 }
    return { sessionId: 7, ok: true }
  } }
  const agent = await startAgent({ directory, backend, secure: () => {} })
  try {
    const endpoint = JSON.parse(fs.readFileSync(path.join(directory, 'endpoint.json')))
    assert.equal(agent.server.address().address, '127.0.0.1')
    const request = (authorization, payload) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: endpoint.port, path: '/call', method: 'POST', headers: { Authorization: authorization } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject); req.end(JSON.stringify(payload))
    })
    assert.equal(await request('Bearer wrong', { name: 'desktop_type', args: { window_id: '123', text: 'danger' } }), 401)
    assert.equal(calls.length, 1)
    assert.equal(await request(`Bearer ${endpoint.token}`, { name: 'run_command', args: {} }), 400)
    const media = await callDesktop('desktop_screenshot', {}, { platform: 'win32', directory })
    assert.equal(media.content[1].type, 'image'); assert.equal(media.content[1].data, 'YWJj')
    const first = callDesktop('desktop_type', { window_id: '123', text: '中文' }, { platform: 'win32', directory })
    await until(() => release)
    await assert.rejects(callDesktop('desktop_mouse', { window_id: '123', action: 'click', x: 0, y: 0 }, { platform: 'win32', directory }), /busy/)
    release(); await first
    assert.equal(calls.filter(c => c.name === 'desktop_mouse').length, 0)
    assert.equal(value(await callDesktop('desktop_displays', {}, { platform: 'win32', directory })).sessionId, 7)
  } finally { release?.(); await agent.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('Windows real broker, own-window capture and opt-in guarded input', { skip: !win, timeout: 60000 }, async t => {
  fs.mkdirSync(evidence, { recursive: true })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-desktop-test-'))
  const stateFile = path.join(directory, 'window.json')
  let agent, client, fixture
  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  try {
    agent = await startAgent({ directory })
    await assert.rejects(startAgent({ directory }), /already running/)
    // The directory DACL is protected and allows this SID only, without inherited access.
    const acl = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$a=Get-Acl -LiteralPath '${directory.replaceAll("'", "''")}'; @{ protected=$a.AreAccessRulesProtected; count=@($a.Access).Count; owner=$a.Owner; identity=$a.Access[0].IdentityReference.Value; current=[Security.Principal.WindowsIdentity]::GetCurrent().Name } | ConvertTo-Json -Compress`], { windowsHide: true, encoding: 'utf8' }))
    assert.equal(acl.protected, true); assert.equal(acl.count, 1); assert.equal(acl.identity, acl.current)
    client = mcp(directory)
    const displays = value(await client.call('desktop_displays'))
    assert.ok(displays.sessionId > 0); assert.ok(displays.monitors.length)
    // Inspect ONLY metadata and PNG header, never emit or view desktop/monitor/region pixels.
    const desktop = saveImage(await client.call('desktop_screenshot'), null)
    assert.ok(Math.max(desktop.imageWidth, desktop.imageHeight) <= 1600)
    const monitor = saveImage(await client.call('desktop_screenshot', { target: 'monitor', monitor: 0, max_dimension: 128 }), null)
    assert.ok(Math.max(monitor.imageWidth, monitor.imageHeight) <= 128)
    const bounds = displays.monitors[0].bounds
    const region = saveImage(await client.call('desktop_screenshot', { target: 'region', x: bounds.x, y: bounds.y, width: 64, height: 64 }), null)
    assert.equal(region.imageWidth, 64)
    const outside = await client.call('desktop_screenshot', { target: 'region', x: -100000, y: -100000, width: 100, height: 100 })
    assert.equal(outside.isError, true)
    fixture = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', path.join(here, 'test-window.ps1'), '-StatePath', stateFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] })
    const before = await until(() => fs.existsSync(stateFile) && readState())
    const target = await until(async () => {
      const windows = value(await client.call('desktop_windows'))
      const match = windows.find(w => w.window_id === before.window_id && w.pid === fixture.pid && w.title === before.title)
      if (!match) fs.writeFileSync(path.join(evidence, 'fixture-debug.json'), JSON.stringify({ before, fixturePid: fixture.pid, ownWindows: windows.filter(w => w.pid === fixture.pid || w.pid === before.pid || w.title.startsWith('AgentBoat hands isolated')) }, null, 2))
      return match
    })
    assert.ok(target, 'target must be the exact fixture handle, pid and title')
    const beforeName = inputEnabled ? 'input-window-before.png' : 'readonly-window.png'
    saveImage(await client.call('desktop_screenshot', { target: 'window', window_id: target.window_id }), beforeName)
    const ownImage = path.join(evidence, beforeName).replaceAll("'", "''")
    const pixel = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Drawing; $b=[Drawing.Bitmap]::FromFile('${ownImage}'); try { $c=$b.GetPixel($b.Width-30,$b.Height-30); '{0},{1},{2}' -f $c.R,$c.G,$c.B } finally { $b.Dispose() }`], { windowsHide: true, encoding: 'utf8' }).trim()
    assert.equal(pixel, '230,240,250', 'DPI-unaware fixture fills the physical capture instead of leaving a black strip')
    // Reject focus/point errors before any SendInput even when input tests are disabled.
    const guarded = await client.call('desktop_mouse', { window_id: target.window_id, action: 'click', x: -100000, y: -100000 })
    assert.equal(guarded.isError, true); assert.match(text(guarded), /FOCUS_LOST|POINT_BLOCKED/)
    let input = 'disabled (set HANDS_TEST_INPUT=1 explicitly)'
    let focus
    let after = readState()
    assert.equal(after.clicks, 0); assert.equal(after.text, '')
    if (inputEnabled) {
      // Explicit opt-in permits foreground activation of this exact fixture only.
      const focused = await client.call('desktop_focus', { window_id: target.window_id })
      focus = focused.isError ? { error: text(focused) } : value(focused)
      if (!focused.isError) {
        assert.equal(focus.window_id, target.window_id); assert.equal(focus.pid, fixture.pid); assert.equal(focus.foreground, true)
      } else assert.match(focus.error, /FOCUS_LOST|User modifier/)
      const current = value(await client.call('desktop_windows')).find(w => w.window_id === target.window_id)
      if (focused.isError || !current?.foreground || current.pid !== fixture.pid || current.title !== before.title) input = `aborted: ${focus.error || 'FOCUS_LOST before any input'}`
      else {
        const clicked = await client.call('desktop_mouse', { window_id: target.window_id, action: 'click', x: before.x, y: before.y })
        if (clicked.isError && /FOCUS_LOST|POINT_BLOCKED|User modifier/.test(text(clicked))) input = `aborted: ${text(clicked)}`
        else {
          value(clicked)
          const typed = await client.call('desktop_type', { window_id: target.window_id, text: 'AgentBoat 中文🛶' })
          if (typed.isError && /FOCUS_LOST|User modifier/.test(text(typed))) input = `aborted: ${text(typed)}`
          else {
            value(typed)
            after = await until(() => { const s = readState(); return s.clicks === 1 && s.text === 'AgentBoat 中文🛶' && s })
            input = 'passed: one click and Unicode text in the exact fixture window'
          }
        }
      }
      after = readState()
      saveImage(await client.call('desktop_screenshot', { target: 'window', window_id: target.window_id }), 'input-window-after.png')
    } else t.diagnostic('Real input disabled; no focus activation or successful SendInput was attempted.')
    const report = { inputEnabled, input, focus, before, after, displays, desktop, monitor, region, acl, screenshots: [path.join(evidence, beforeName), ...(inputEnabled ? [path.join(evidence, 'input-window-after.png')] : [])] }
    fs.writeFileSync(path.join(evidence, inputEnabled ? 'input-report.json' : 'readonly-report.json'), JSON.stringify(report, null, 2))
    t.diagnostic(input)
  } finally {
    if (fixture) {
      fs.writeFileSync(stateFile + '.stop', '')
      await until(() => fixture.exitCode !== null).catch(() => fixture.kill())
    }
    client?.child.stdin.end()
    if (client) await until(() => client.child.exitCode !== null).catch(() => client.child.kill())
    await agent?.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Windows interactive logon task launches a reachable broker (explicit opt-in)', { skip: !win || process.env.HANDS_TEST_LOGON !== '1', timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-logon-test-'))
  const taskName = `AgentBoat-Hands-Test-${process.pid}`
  const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8' })
  let endpoint
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(here, 'start-desktop.ps1'), '-RegisterLogonTask', '-TaskName', taskName, '-CredentialDirectory', directory, '-NodePath', process.execPath], { windowsHide: true, encoding: 'utf8' })
    endpoint = await until(() => fs.existsSync(path.join(directory, 'endpoint.json')) && JSON.parse(fs.readFileSync(path.join(directory, 'endpoint.json'))), 20000)
    const info = value(await callDesktop('desktop_displays', {}, { directory }))
    const principal = ps(`(Get-ScheduledTask -TaskName '${taskName}').Principal.LogonType.ToString()`).trim()
    assert.equal(principal, 'Interactive')
    assert.ok(info.sessionId > 0)
    const report = { taskName, principal, sessionId: info.sessionId, pid: endpoint.pid, reachableThroughLoopback: true, cleanup: 'temporary task and process removed in finally; not a two-machine SSH test' }
    fs.mkdirSync(evidence, { recursive: true })
    fs.writeFileSync(path.join(evidence, 'logon-report.json'), JSON.stringify(report, null, 2))
    t.diagnostic(`Interactive task started broker in session ${info.sessionId}; authenticated relay succeeded.`)
  } finally {
    ps(`$task=Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; if($task) { $task | Stop-ScheduledTask; $task | Unregister-ScheduledTask -Confirm:$false }`)
    // Only our own endpoint's PID is eligible for cleanup; never terminate by process name.
    if (endpoint) { try { process.kill(endpoint.pid) } catch {} }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
