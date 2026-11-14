// Run in the interactive user's session, never inside an SSH service session.
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { desktopDirectory, validateDesktop } from './desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function protectDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
  for (let p = path.resolve(directory);; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) throw new Error('Desktop credential directory must not traverse reparse points.')
    if (path.dirname(p) === p) break
  }
  // Set an explicit protected DACL before writing any secret; inherited access is removed.
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(path.resolve(directory)).toString('base64')}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[IO.Directory]::GetAccessControl($p,([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner)); if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Desktop credential directory belongs to another user.' }; $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }; $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); [IO.Directory]::SetAccessControl($p,$acl)`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' })
}

function startBackend(directory) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', path.join(here, 'desktop-windows.ps1'), '-CredentialDirectory', path.resolve(directory)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map(); let id = 0; let stderr = ''
  child.stderr.on('data', c => { stderr = (stderr + c.toString()).slice(-4000) })
  const fail = e => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e) } pending.clear() }
  child.stdin.on('error', fail)
  child.on('error', fail)
  child.on('exit', code => fail(new Error(`Desktop backend exited (${code}): ${stderr}`)))
  createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id); clearTimeout(p.timer)
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result)
  })
  return {
    child,
    call(name, args) {
      if (child.exitCode !== null || child.killed) return Promise.reject(new Error('Desktop backend is no longer running. Restart the agent.'))
      return new Promise((resolve, reject) => {
        const requestId = ++id
        const timer = setTimeout(() => {
          // Kill the backend on timeout so queued/late input cannot execute after reporting failure.
          child.kill(); fail(new Error('Desktop backend timed out and was stopped. Input outcome is unknown; do not retry automatically.'))
        }, 15000)
        pending.set(requestId, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ id: requestId, name, args }) + '\n', e => { if (e) fail(e) })
      })
    },
  }
}

export async function startAgent({ directory = desktopDirectory(), createBackend = startBackend, secure = protectDirectory } = {}) {
  secure(directory)
  const token = randomBytes(32).toString('hex')
  const endpointFile = path.join(directory, 'endpoint.json')
  let server, backend
  const call = (name, args) => {
    if (!backend || backend.child?.exitCode != null || backend.child?.signalCode != null || backend.child?.killed) backend = createBackend(directory)
    return backend.call(name, args)
  }
  let ownsEndpoint = false
  const cleanup = () => {
    backend?.child?.kill()
    if (ownsEndpoint) {
      try { if (JSON.parse(fs.readFileSync(endpointFile, 'utf8')).token === token) fs.rmSync(endpointFile) } catch { /* Already removed or superseded. */ }
    }
  }
  try {
    await call('desktop_displays', {}) // fail before publishing an unusable agent
    // The backend owns a per-user OS mutex, released even after crashes/reboots.
    ownsEndpoint = true
    fs.rmSync(endpointFile, { force: true })
    let busy = false
    server = http.createServer(async (req, res) => {
      const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
      const supplied = Buffer.from(req.headers.authorization || '')
      const expected = Buffer.from(`Bearer ${token}`)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reply(401, { error: 'Unauthorized' }); req.resume(); return }
      if (req.method !== 'POST' || req.url !== '/call') { reply(404, { error: 'Not found' }); req.resume(); return }
      if (busy) { reply(409, { error: 'Desktop agent is busy; no input was sent for this request.' }); req.resume(); return }
      const chunks = []; let size = 0
      try {
        for await (const c of req) {
          size += c.length
          if (size > 100000) { reply(413, { error: 'Request too large' }); req.resume(); return }
          chunks.push(c)
        }
        const { name, args } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        validateDesktop(name, args)
        // Recheck after body reads: another request may have acquired the desktop meanwhile.
        if (busy) { reply(409, { error: 'Desktop agent is busy; no input was sent for this request.' }); return }
        busy = true
        try {
          const result = await call(name, args)
          if (name === 'desktop_screenshot') {
            const { data, ...metadata } = result
            reply(200, { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType: 'image/png', data }] })
          } else reply(200, { content: [{ type: 'text', text: JSON.stringify(result) }] })
        } finally { busy = false }
      } catch (e) { if (!res.headersSent) reply(400, { error: e.message }) }
    })
    server.requestTimeout = 5000; server.headersTimeout = 5000
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    fs.writeFileSync(endpointFile, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600, flag: 'wx' })
    return { server, close: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); cleanup() } }
  } catch (e) { server?.close(); cleanup(); throw e }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.platform !== 'win32') { console.error('Desktop agent 暂不支持: Windows only.'); process.exitCode = 1 }
  else {
    try {
      const agent = await startAgent()
      console.error(`Hands desktop agent ready; credentials: ${path.join(desktopDirectory(), 'endpoint.json')}`)
      const stop = async () => { await agent.close(); process.exit(0) }
      process.once('SIGINT', stop); process.once('SIGTERM', stop)
    } catch (e) { console.error(e.message); process.exitCode = 1 }
  }
}
