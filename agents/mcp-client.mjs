import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// Test driver for a real stdio server; every request has a deadline and disconnect rejects pending work.
export function client(server) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) })
  let id = 0, errors = '', stopped
  const pending = new Map()
  child.stderr.on('data', data => { errors = (errors + data).slice(-4000) })
  const fail = error => { stopped = error; for (const request of pending.values()) request.reject(error) }
  createInterface({ input: child.stdout }).on('line', line => {
    try { const message = JSON.parse(line); pending.get(message.id)?.resolve(message) }
    catch { fail(new Error('Invalid JSON in MCP response')) }
  })
  child.stdin.on('error', fail)
  child.on('error', fail)
  child.on('exit', code => fail(new Error(`MCP exited ${code}: ${errors}`)))
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (stopped) { reject(stopped); return }
    const current = ++id
    const timer = setTimeout(() => done(reject, new Error(`MCP timed out: ${method}`)), 35000)
    const done = (fn, value) => { clearTimeout(timer); pending.delete(current); fn(value) }
    pending.set(current, { resolve: message => done(resolve, message), reject: error => done(reject, error) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n')
  })
  return { child, rpc, async call(name, args = {}) {
    const { result, error } = await rpc('tools/call', { name, arguments: args })
    if (error) throw new Error(JSON.stringify(error))
    return { ...result, text: result.content.filter(c => c.type === 'text').map(c => c.text).join('\n') }
  }, close: () => {
    child.stdin.end()
    return exited
  } }
}
