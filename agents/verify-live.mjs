#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { fixtures } from './fixtures.mjs'
import { summarize } from './summarize.mjs'

const { values } = parseArgs({ options: { agent: { type: 'string' }, model: { type: 'string' }, out: { type: 'string' } } })
if (!['claude', 'codex'].includes(values.agent) || !values.model || !values.out) throw new Error('Usage: node verify-live.mjs --agent claude|codex --model <cheap-model> --out <new-evidence-directory>')
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(values.out)
fs.mkdirSync(out)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-live-'))
const root = path.join(temp, 'remote'), directory = path.join(temp, 'host')
fixtures(root)
fs.writeFileSync(path.join(temp, 'outside.txt'), 'OUTSIDE_SECRET')
const run = (file, args, stdout, stderr) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', c => { stdout.write(c) })
  child.stderr.on('data', c => { stderr.write(c) })
  child.on('error', reject); child.on('close', resolve)
})
const prompt = 'Use hands for project work. In order: read utf8.txt and gbk.txt; view red.png and name its color; read doc.pdf' + (values.agent === 'codex' ? ' with pdf_format=text' : ' as document (Read the Claude PDF cache path if needed)') + '; find **/*.txt and search Boat; read edit.txt, edit before to after, then run node verify.cjs; start node ticker.cjs background, get its output (retry output if empty), stop it; read ../outside.txt (must reject). No desktop calls. Final short JSON: utf8,gbk,color,pdf,search,edit,background,boundary,localToolNames (list built-in host file/exec/patch tools visible, do not call them except Claude PDF cache Read).'
try {
  const genLog = fs.createWriteStream(path.join(out, 'generation.json'))
  const genErr = fs.createWriteStream(path.join(out, 'generation.stderr.txt'))
  const gen = await run(path.join(here, 'generate.mjs'), ['--agent', values.agent, '--model', values.model, '--local', '--hands', path.join(here, '..', 'hands.mjs'), '--root', root, '--out', directory,
    ...(process.env.HANDS_PDF_PYTHON ? ['--pdf-python', process.env.HANDS_PDF_PYTHON] : [])], genLog, genErr)
  genLog.end(); genErr.end()
  if (gen !== 0) throw new Error(`Generation failed with ${gen}`)
  for (const file of fs.readdirSync(directory)) fs.copyFileSync(path.join(directory, file), path.join(out, file))
  fs.writeFileSync(path.join(out, 'prompt.txt'), prompt)
  const stdout = fs.createWriteStream(path.join(out, 'events.jsonl')), stderr = fs.createWriteStream(path.join(out, 'stderr.txt'))
  const code = await run(path.join(here, 'run.mjs'), [directory, prompt], stdout, stderr)
  await Promise.all([new Promise(r => stdout.end(r)), new Promise(r => stderr.end(r))])
  fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ agent: values.agent, model: values.model, code, transport: 'local stdio, SSH unavailable', temp, edited: fs.readFileSync(path.join(root, 'edit.txt'), 'utf8'), at: new Date().toISOString() }, null, 2) + '\n')
  if (code === 0) summarize(out)
  console.log(JSON.stringify({ agent: values.agent, code, out }))
  process.exitCode = code
} finally {
  // Remove only this fixture tree; retain the transcript and generated argv in out.
  fs.rmSync(temp, { recursive: true, force: true })
}
