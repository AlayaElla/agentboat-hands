#!/usr/bin/env node
// Keep argv intact, including empty arguments and TOML quotes, without going through a host shell.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const [directory, ...prompt] = process.argv.slice(2)
if (!directory || !prompt.length) throw new Error('Usage: node run.mjs <generated-directory> <prompt>')
const launch = JSON.parse(fs.readFileSync(path.resolve(directory, 'launch.json'), 'utf8'))
const codex = /^codex(?:\.(?:exe|cmd|ps1))?$/i.test(path.basename(launch.command))
if (codex && !launch.args.includes('--json')) throw new Error('Codex guard requires --json events. Regenerate this launch configuration.')
const text = (launch.promptFile ? fs.readFileSync(launch.promptFile, 'utf8') + '\nTask:\n' : '') + prompt.join(' ')
// Skill bodies can exceed Windows argv limits; Claude and Codex accept prompts over stdin.
const args = [...launch.args, ...(launch.promptFile ? (codex ? ['-'] : []) : [text])]
let command = launch.command
if (process.platform === 'win32' && !path.isAbsolute(command)) {
  const found = execFileSync('where.exe', [command], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)
  const executable = found.find(file => /\.exe$/i.test(file))
  if (executable) command = executable
  else if (command === 'codex') {
    const entry = found.map(file => path.join(path.dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')).find(file => fs.existsSync(file))
    if (!entry) throw new Error('Cannot resolve the installed Codex npm entrypoint; use its native executable.')
    command = process.execPath; args.unshift(entry)
  } else throw new Error(`Use a native ${command}.exe on Windows; a shell wrapper cannot preserve arbitrary argv.`)
}
const child = spawn(command, args, { cwd: launch.cwd, stdio: [launch.promptFile ? 'pipe' : 'inherit', codex ? 'pipe' : 'inherit', 'inherit'], windowsHide: true, detached: codex && process.platform !== 'win32' })
if (launch.promptFile) {
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') console.error(error.message) })
  child.stdin.end(text)
}
let stopped = false
function stop(reason) {
  if (stopped) return
  stopped = true
  console.error(`Codex guard: ${reason}. Stopping Codex and its child processes; a reported operation may already have run.`)
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') console.error(`Codex guard: could not stop the full process tree: ${error.message}`)
    child.kill('SIGKILL')
  }
}
if (codex) {
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    if (stopped || !line.trim()) return
    let event
    try { event = JSON.parse(line) } catch { stop('invalid JSON event stream; monitoring is unavailable'); return }
    if (!event || typeof event.type !== 'string') { stop('invalid event envelope; monitoring is unavailable'); return }
    const item = event.item
    if (item?.type === 'command_execution') stop(`${event.type}/command_execution, command=${JSON.stringify(item.command ?? '(not reported)')}`)
    if (item?.type === 'file_change') stop(`${event.type}/file_change, files=${JSON.stringify(Array.isArray(item.changes) ? item.changes.map(change => change?.path) : [])}`)
  })
  child.stdout.pipe(process.stdout)
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(`runner received ${signal}`))
}
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
// Wait for stdout to drain so a final, unterminated JSON event cannot override the guard with exit 0.
child.on('close', code => { process.exitCode = stopped ? 2 : code ?? 1 })
