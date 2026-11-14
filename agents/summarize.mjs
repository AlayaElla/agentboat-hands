#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function summarize(directory) {
  const run = JSON.parse(fs.readFileSync(path.join(directory, 'run.json')))
  const events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  const calls = [], pending = new Map()
  let final, usage, costUSD, init
  for (const event of events) {
    if (event.type === 'system' && event.subtype === 'init') init = event
    if (event.type === 'assistant') for (const block of event.message.content) if (block.type === 'tool_use') pending.set(block.id, { name: block.name, args: block.input })
    if (event.type === 'user') for (const block of event.message.content) if (block.type === 'tool_result') {
      const call = pending.get(block.tool_use_id)
      if (call) calls.push({ ...call, result: block.content, error: !!block.is_error })
    }
    if (event.type === 'item.completed' && event.item.type === 'mcp_tool_call') calls.push({ name: `mcp__${event.item.server}__${event.item.tool}`, args: event.item.arguments, result: event.item.result?.content, error: event.item.status === 'failed' })
    if (event.type === 'item.completed' && event.item.type === 'agent_message') final = event.item.text
    if (event.type === 'result') { final = event.result; usage = event.usage; costUSD = event.total_cost_usd }
    if (event.type === 'turn.completed') usage = event.usage
  }
  const answer = JSON.parse(final.match(/\{[\s\S]*\}/)[0])
  const text = call => typeof call.result === 'string' ? call.result : (call.result || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
  const found = (name, check) => calls.some(c => c.name === `mcp__hands__${name}` && check(c))
  const checks = {
    utf8: found('read_file', c => c.args.path === 'utf8.txt' && /Boat UTF8: 中文/.test(text(c))),
    gbk: found('read_file', c => c.args.path === 'gbk.txt' && /GBK-encoded[\s\S]*中文/.test(text(c))),
    image: found('read_file', c => c.args.path === 'red.png' && c.result.some(x => x.type === 'image')) && /red/i.test(answer.color),
    pdf: found('read_file', c => c.args.path === 'doc.pdf') && /7319/.test(answer.pdf),
    find: found('find_files', c => /utf8.txt/.test(text(c))),
    search: found('search_content', c => /utf8.txt:1:Boat UTF8: 中文/.test(text(c))),
    editAndExecute: run.edited.trim() === 'after' && found('edit_file', c => c.args.path === 'edit.txt' && !c.error) && found('run_command', c => /verify.cjs/.test(c.args.command) && /exit code: 0\nEDIT_OK/.test(text(c))),
    background: found('run_command', c => c.args.background && /Started p\d+/.test(text(c))) && found('process_output', c => /running[\s\S]*BOAT_TICK/.test(text(c))) && found('stop_process', c => /exited with code/.test(text(c))),
    boundary: found('read_file', c => c.args.path === '../outside.txt' && c.error && /Outside the allowed folders/.test(text(c))),
    onlyHands: calls.every(c => c.name.startsWith('mcp__hands__') || (run.agent === 'claude' && c.name === 'Read' && /[\\/]\.claude[\\/]projects[\\/]/.test(c.args.file_path))) && !events.some(e => e.item?.type === 'command_execution' || e.item?.type === 'file_change'),
  }
  if (run.agent === 'claude') {
    checks.pdfCache = calls.some(c => c.name === 'Read' && /\.pdf$/i.test(c.args.file_path) && !c.error)
    assert.deepEqual(init.tools.filter(name => !name.startsWith('mcp__hands__')), ['Read'])
  } else checks.pdfText = found('read_file', c => c.args.path === 'doc.pdf' && c.args.pdf_format === 'text' && /7319/.test(text(c)))
  assert.equal(run.code, 0)
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, `${run.agent}: ${name}`)
  const summary = { agent: run.agent, model: init?.model || run.model, checks, usage, ...(costUSD === undefined ? { costUSD: null, billing: 'CLI exposes tokens only; subscription percentage and USD debit unavailable' } : { costUSD }), callCount: calls.length, answer, calls }
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  return { ...summary, calls: undefined }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const directory of process.argv.slice(2)) console.log(JSON.stringify(summarize(directory), null, 2))
}
