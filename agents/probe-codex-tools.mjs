#!/usr/bin/env node
// Inspect the installed harness registry with a local fake Responses endpoint, without spending model tokens.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { generate, transport } from './generate.mjs'
import { zstdDecompressSync, gunzipSync } from 'node:zlib'
import assert from 'node:assert/strict'

const out = path.resolve(process.argv[2] || 'codex-tools.json')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-registry-'))
const here = path.dirname(fileURLToPath(import.meta.url))
let captured, requestKeys, toolFields, inputShape, mentions
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return }
  let body = Buffer.concat(chunks)
  if (req.headers['content-encoding'] === 'zstd') body = zstdDecompressSync(body)
  if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body)
  const request = JSON.parse(body.toString('utf8'))
  requestKeys = Object.keys(request)
  inputShape = (request.input || []).map(item => ({ type: item.type, role: item.role, keys: Object.keys(item), contentTypes: Array.isArray(item.content) ? item.content.map(c => c.type) : typeof item.content }))
  const input = JSON.stringify(request.input)
  mentions = Object.fromEntries(['exec_command', 'apply_patch', 'mcp__hands__read_file', 'namespace functions'].map(name => [name, [...input.matchAll(new RegExp(name, 'g'))].slice(0, 5).map(hit => input.slice(Math.max(0, hit.index - 80), hit.index + name.length + 80))]))
  toolFields = Object.fromEntries(Object.entries(request).filter(([key]) => /tool|catalog/i.test(key)).map(([key, value]) => [key, Array.isArray(value) ? { length: value.length, firstKeys: value.length ? Object.keys(value[0]) : [] } : typeof value]))
  captured = [...(request.tools || []), ...(request.input || []).flatMap(item => item.type === 'additional_tools' ? item.tools : [])]
    .map(tool => ({ type: tool.type, name: tool.name || tool.function?.name, tools: tool.tools?.map(t => t.name) }))
  // Never retain headers, authorization or prompt content.
  const response = { id: 'resp_local_registry_probe', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
})
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const result = generate({ agent: 'codex', root: temp, directory: temp, model: 'gpt-6-luna', server: transport({ local: true, root: temp, hands: path.join(here, '..', 'hands.mjs') }) })
  result.launch.args.push('-c', `openai_base_url="http://127.0.0.1:${server.address().port}/v1"`)
  fs.writeFileSync(path.join(temp, 'launch.json'), JSON.stringify(result.launch))
  const child = spawn(process.execPath, [path.join(here, 'run.mjs'), temp, 'Reply OK without calling any tools.'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', c => { stderr += c })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  if (!captured) throw new Error(`Registry capture failed (${code}): ${stderr}`)
  assert.ok(captured.length, 'capture must include the additional_tools input registry, not only the legacy top-level tools field')
  const report = { cliVersion: '0.167.1', model: 'gpt-6-luna', fixture: 'local fake Responses endpoint; no model inference or real API usage', flags: ['features.shell_tool=false', 'features.unified_exec=false', 'sandbox_mode=read-only', 'windows.sandbox=unelevated'], requestKeys, inputShape, mentions, toolFields, tools: captured, code }
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(temp, { recursive: true, force: true })
}
