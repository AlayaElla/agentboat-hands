#!/usr/bin/env node
// Keep argv intact, including empty arguments and TOML quotes, without going through a host shell.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [directory, ...prompt] = process.argv.slice(2)
if (!directory || !prompt.length) throw new Error('Usage: node run.mjs <generated-directory> <prompt>')
const launch = JSON.parse(fs.readFileSync(path.resolve(directory, 'launch.json'), 'utf8'))
const args = [...launch.args, prompt.join(' ')]
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
const child = spawn(command, args, { cwd: launch.cwd, env: { ...process.env, ...launch.env }, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
