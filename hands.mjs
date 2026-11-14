#!/usr/bin/env node
// AgentBoat hands: a dependency-free MCP (stdio) tool server. It lets an agent running on another
// machine read, edit, search and run commands on this one, for any agent that speaks MCP.
//
// Usage:  node hands.mjs <root-folder> [more-root-folders...]
// File tools refuse paths outside the roots. Commands start in the first root and are NOT sandboxed:
// whoever can reach this process can run anything as this user, so only expose it over SSH.
import { execFile, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { desktopTools } from './desktop.mjs'
import { pdfText } from './agents/pdf.mjs'

const win = process.platform === 'win32'
const real = p => fs.realpathSync.native(p)
const fold = p => (win ? p.toLowerCase() : p)
const rootArgs = process.argv.slice(2)
if (!rootArgs.length) {
  console.error('Usage: node hands.mjs <root-folder> [more-root-folders...]')
  process.exit(1)
}
const roots = rootArgs.map(r => real(path.resolve(r)))

const MAX_CHARS = 40000 // one text result; larger ones get dumped to a file by the calling agent
const MAX_TEXT_BYTES = 20_000_000
const MAX_BLOB_BYTES = 3_500_000 // images and PDFs travel as base64, which model APIs cap near 5 MB
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const SKIP_DIRS = new Set(['.git', 'node_modules'])

// ---------- paths ----------

function inRoots(p) {
  const abs = path.resolve(roots[0], String(p))
  let probe = abs // resolve links on the deepest existing ancestor, so a link cannot lead outside the roots
  while (!fs.lstatSync(probe, { throwIfNoEntry: false }) && path.dirname(probe) !== probe) probe = path.dirname(probe)
  const full = path.join(real(probe), path.relative(probe, abs))
  const inside = roots.some(r => fold(full) === fold(r) || fold(full).startsWith(fold(r.endsWith(path.sep) ? r : r + path.sep)))
  if (!inside) throw new Error(`Outside the allowed folders: ${abs}. Allowed: ${roots.join(', ')}`)
  return full
}

function* walk(dir, skip = SKIP_DIRS) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (!skip.has(e.name)) yield* walk(full, skip) } else if (e.isFile()) yield full
  }
}

function globToRegExp(glob) {
  const lit = s => s.replace(/[.+^$()|[\]\\]/g, '\\$&')
  const fragment = glob => {
    let re = ''
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i]
      const close = c === '{' ? glob.indexOf('}', i) : -1
      if (c === '*' && glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/'
        re += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else if (c === '*') re += '[^/]*'
      else if (c === '?') re += '[^/]'
      else if (close > i) { re += '(?:' + glob.slice(i + 1, close).split(',').map(fragment).join('|') + ')'; i = close } else re += lit(c)
    }
    return re
  }
  return new RegExp('^' + fragment(glob) + '$', win ? 'i' : '')
}

const slashed = (base, file) => path.relative(base, file).split(path.sep).join('/')

// ---------- text encodings ----------

// Returns null for binary data. Text that is not valid UTF-8 is taken as GBK, the usual legacy
// encoding on Chinese Windows.
function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.toString('utf8', 3), enc: 'utf8', bom: true }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.toString('utf16le', 2), enc: 'utf16le', bom: true }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), enc: 'utf16be', bom: true }
  if (buf.includes(0)) return null
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), enc: 'utf8', bom: false } } catch { /* not UTF-8 */ }
  return { text: new TextDecoder('gb18030').decode(buf), enc: 'gb18030', bom: false }
}

function encode(text, { enc, bom }) {
  if (enc === 'utf8') return Buffer.concat([Buffer.from(bom ? [0xef, 0xbb, 0xbf] : []), Buffer.from(text, 'utf8')])
  if (enc === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  if (enc === 'utf16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])
  // shortcut: GBK files are read-only because Node cannot encode GBK without a library; add iconv-lite when someone needs to edit one.
  throw new Error('This file is GBK-encoded. It can be read but not written; convert it to UTF-8 with a command first.')
}

// Command output can mix UTF-8 and GBK (native Windows tools write in the console code page), so decode per line.
const decodeOutput = buf => {
  const lines = []
  for (let from = 0; from <= buf.length;) {
    const nl = buf.indexOf(0x0a, from)
    const end = nl === -1 ? buf.length : nl
    lines.push((decode(buf.subarray(from, end))?.text ?? buf.toString('latin1', from, end)).replace(/\r$/, ''))
    from = end + 1
  }
  return lines.join('\n')
}

const clip = (text, max = 30000) =>
  text.length <= max ? text : `${text.slice(0, max / 3)}\n[... ${text.length - max} characters omitted ...]\n${text.slice(-(max * 2) / 3)}`

// ---------- file tools ----------

const seen = new Map() // file → mtime when this session last read or wrote it

function assertFresh(file) {
  const at = seen.get(file)
  if (at === undefined) throw new Error('Read this file with read_file before changing it.')
  if (fs.statSync(file).mtimeMs !== at) throw new Error('The file changed since you read it. Read it again first.')
}

function save(file, text, style) {
  fs.writeFileSync(file, encode(style.crlf ? text.replace(/\r?\n/g, '\r\n') : text, style))
  seen.set(file, fs.statSync(file).mtimeMs)
}

async function readFile({ path: p, offset, limit, pdf_format = 'document' }) {
  const file = inRoots(p)
  const stat = fs.statSync(file)
  if (stat.isDirectory()) throw new Error('That is a folder. Use list_directory.')
  const ext = path.extname(file).toLowerCase()
  if (!['document', 'text'].includes(pdf_format)) throw new Error('pdf_format must be document or text.')
  if (ext === '.pdf' && pdf_format === 'text') {
    if (stat.size > MAX_TEXT_BYTES) throw new Error(`PDF is ${stat.size} bytes; text extraction is limited to ${MAX_TEXT_BYTES}.`)
    const text = await pdfText(file)
    return text.trim() ? textLines(text, offset, limit) : '[PDF has no extractable text. Scanned pages need OCR; document mode remains available.]'
  }
  if (IMAGES[ext] || ext === '.pdf') {
    if (stat.size > MAX_BLOB_BYTES) throw new Error(`File is ${stat.size} bytes; images and PDFs are limited to ${MAX_BLOB_BYTES}. Shrink or convert it with a command.`)
    const data = fs.readFileSync(file).toString('base64')
    if (IMAGES[ext]) return [{ type: 'image', data, mimeType: IMAGES[ext] }]
    return [
      { type: 'resource', resource: { uri: pathToFileURL(file).href, mimeType: 'application/pdf', blob: data } },
      { type: 'text', text: 'The PDF is attached as a document. For plain text, call read_file on the same path with pdf_format="text".' },
    ]
  }
  if (stat.size > MAX_TEXT_BYTES) throw new Error(`File is ${stat.size} bytes, too large to load. View part of it with run_command.`)
  const decoded = decode(fs.readFileSync(file))
  if (!decoded) throw new Error('Binary file. Inspect or convert it with run_command.')
  seen.set(file, stat.mtimeMs)
  return textLines(decoded.text, offset, limit, decoded.enc === 'gb18030' ? 'GBK-encoded: can be read but not edited' : '')
}

function textLines(text, offset, limit, note) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (!lines.length) return '(empty file)'
  const first = Math.max(1, Number(offset) || 1)
  if (first > lines.length) return `[the file has only ${lines.length} lines]`
  const out = []
  let budget = MAX_CHARS
  for (const line of lines.slice(first - 1, first - 1 + (Number(limit) || 2000))) {
    if (line.length > budget) {
      if (!out.length) out.push(line.slice(0, budget) + ' [line cut here]')
      break
    }
    out.push(line)
    budget -= line.length + 1
  }
  const last = first + out.length - 1
  const notes = []
  if (note) notes.push(note)
  if (first > 1 || last < lines.length) notes.push(`lines ${first}-${last} of ${lines.length}` + (last < lines.length ? `; continue with offset=${last + 1}` : ''))
  return (notes.length ? `[${notes.join('; ')}]\n` : '') + out.join('\n')
}

function writeFile({ path: p, content }) {
  const file = inRoots(p)
  let style = { enc: 'utf8', bom: false, crlf: false }
  if (fs.existsSync(file)) {
    assertFresh(file)
    const old = decode(fs.readFileSync(file))
    if (old) style = { ...old, crlf: old.text.includes('\r\n') } // keep the file's encoding and line endings
  } else fs.mkdirSync(path.dirname(file), { recursive: true })
  save(file, String(content), style)
  return `Wrote ${file}`
}

function editFile({ path: p, old_string, new_string, replace_all }) {
  const file = inRoots(p)
  assertFresh(file)
  const cur = decode(fs.readFileSync(file))
  const lf = s => String(s).replace(/\r\n/g, '\n')
  const text = lf(cur.text)
  const find = lf(old_string)
  if (!find) throw new Error('old_string is empty.')
  const count = text.split(find).length - 1
  if (!count) throw new Error('old_string was not found. It must match the file exactly, including spaces and indentation.')
  if (count > 1 && !replace_all) throw new Error(`old_string appears ${count} times. Include more surrounding text to make it unique, or set replace_all.`)
  save(file, text.split(find).join(lf(new_string)), { ...cur, crlf: cur.text.includes('\r\n') })
  return `Replaced ${count} occurrence${count > 1 ? 's' : ''} in ${file}`
}

function listDirectory({ path: p = '.' }) {
  const dir = inRoots(p)
  const rows = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
    if (e.isDirectory()) return e.name + '/'
    let size = '?'
    try { size = fs.statSync(path.join(dir, e.name)).size } catch { /* broken link */ }
    return `${e.name}  ${size} bytes`
  })
  return rows.join('\n') || '(empty folder)'
}

function findFiles({ pattern, path: p = '.' }) {
  const base = inRoots(p)
  const re = globToRegExp(String(pattern).replace(/\\/g, '/'))
  const skip = String(pattern).includes('node_modules') ? new Set(['.git']) : SKIP_DIRS
  const hits = []
  for (const file of walk(base, skip)) {
    const rel = slashed(base, file)
    if (!re.test(rel)) continue
    try { hits.push([fs.statSync(file).mtimeMs, rel]) } catch { /* vanished while scanning */ }
  }
  hits.sort((a, b) => b[0] - a[0]) // newest first
  const shown = hits.slice(0, 200).map(h => h[1])
  return (shown.join('\n') || 'No files matched.') + (hits.length > 200 ? `\n[${hits.length - 200} more not shown; narrow the pattern]` : '')
}

// shortcut: scans files in-process, which is slow on very large trees; shell out to ripgrep if that starts to matter.
function searchContent({ pattern, path: p = '.', glob, ignore_case, files_only, context, max_results }) {
  const base = inRoots(p)
  const re = new RegExp(String(pattern), ignore_case ? 'i' : '')
  const only = glob && globToRegExp(String(glob).replace(/\\/g, '/'))
  const around = Math.max(0, Number(context) || 0)
  const max = Number(max_results) || 100
  const single = fs.statSync(base).isFile()
  const out = []
  let matches = 0
  for (const file of single ? [base] : walk(base)) {
    const rel = single ? path.basename(file) : slashed(base, file)
    if (only && !only.test(String(glob).includes('/') ? rel : path.basename(file))) continue
    let decoded
    try { decoded = fs.statSync(file).size <= 2_000_000 && decode(fs.readFileSync(file)) } catch { continue }
    if (!decoded) continue
    const lines = decoded.text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      matches++
      if (files_only) { out.push(rel); break }
      for (let k = Math.max(0, i - around); k <= Math.min(lines.length - 1, i + around); k++) {
        out.push(`${rel}:${k + 1}${k === i ? ':' : '-'}${lines[k].slice(0, 300)}`)
      }
      if (around) out.push('--')
      if (matches >= max) return out.join('\n') + `\n[stopped at ${max} matches; narrow the search or raise max_results]`
    }
    if (files_only && matches >= max) return out.join('\n') + `\n[stopped at ${max} files]`
  }
  return out.join('\n') || 'No matches.'
}

// ---------- commands ----------

const procs = new Map() // id → { child, command, chunks, size, code }
const foreground = new Set() // children of commands still waiting for a result
let procCount = 0

function shellCommand(command, shell) {
  if (!win) return { file: 'sh', args: ['-c', command] }
  if (shell === 'bash') return { file: 'bash', args: ['-c', command] }
  if (shell === 'cmd') return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`], verbatim: true }
  // -EncodedCommand sidesteps every quoting problem. The trailer returns the real exit code of a failed
  // program, which PowerShell would otherwise flatten to 0 or 1.
  const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n${command}\n` +
    '$__ok=$?; if (-not $__ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }'
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
}

function killTree(pid, sync = false) {
  try {
    if (!win) process.kill(-pid, 'SIGKILL') // the child leads its own process group
    else if (sync) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'])
    else execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
  } catch { /* already gone */ }
}

function runCommand({ command, cwd, timeout_ms, shell, background }) {
  const directory = cwd ? inRoots(cwd) : roots[0]
  if (!fs.existsSync(directory)) throw new Error(`Working directory does not exist: ${directory}`)
  if (!fs.statSync(directory).isDirectory()) throw new Error(`Working directory is not a folder: ${directory}`)
  const { file, args, verbatim } = shellCommand(String(command), shell)
  const child = spawn(file, args, {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: !!verbatim,
    windowsHide: true,
    detached: !win,
  })

  if (background) {
    const id = 'p' + ++procCount
    const proc = { child, command: String(command), chunks: [], size: 0, code: undefined }
    const keep = chunk => {
      proc.chunks.push(chunk)
      proc.size += chunk.length
      while (proc.size > 1_000_000 && proc.chunks.length > 1) proc.size -= proc.chunks.shift().length // keep the newest megabyte
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', e => { keep(Buffer.from(String(e.message))); proc.code = -1 })
    child.on('close', code => { proc.code = code ?? -1 })
    procs.set(id, proc)
    return `Started ${id} (pid ${child.pid}). Read its output with process_output; stop it with stop_process.`
  }

  return new Promise((resolve, reject) => {
    const out = { chunks: [], size: 0, truncated: false }
    const err = { chunks: [], size: 0, truncated: false }
    const maxBytes = 2 * 1024 * 1024
    const keep = (stream, chunk) => {
      const remaining = maxBytes - stream.size
      if (chunk.length > remaining) stream.truncated = true
      if (remaining > 0) {
        const kept = Buffer.from(chunk.subarray(0, remaining))
        stream.chunks.push(kept)
        stream.size += kept.length
      }
    }
    let timedOut = false
    const limit = Math.min(Number(timeout_ms) || 120000, 600000)
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, limit)
    foreground.add(child)
    child.stdout.on('data', c => keep(out, c))
    child.stderr.on('data', c => keep(err, c))
    child.on('error', e => { clearTimeout(timer); foreground.delete(child); reject(new Error(`Could not start the command: ${e.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      foreground.delete(child)
      const stdout = decodeOutput(Buffer.concat(out.chunks)).trimEnd()
      const stderr = decodeOutput(Buffer.concat(err.chunks)).trimEnd()
      const head = timedOut ? `timed out after ${limit} ms and was stopped` : `exit code: ${code}`
      const text = clip([head, ...[['stdout', out], ['stderr', err]].filter(([, stream]) => stream.truncated).map(([name]) => `[${name} truncated at ${maxBytes} bytes]`), stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n'))
      resolve({ content: [{ type: 'text', text }], isError: timedOut || code !== 0 })
    })
  })
}

const status = proc => (proc.code === undefined ? 'running' : `exited with code ${proc.code}`)

function processOutput({ id }) {
  if (!id) return [...procs].map(([k, p]) => `${k}  ${status(p)}  ${p.command.slice(0, 80)}`).join('\n') || 'No background processes.'
  const proc = procs.get(String(id))
  if (!proc) throw new Error(`No background process ${id}. Call process_output without an id to list them.`)
  return `${status(proc)}\n${clip(decodeOutput(Buffer.concat(proc.chunks)), 20000)}`
}

async function stopProcess({ id }) {
  const proc = procs.get(String(id))
  if (!proc) throw new Error(`No background process ${id}.`)
  if (proc.code === undefined) {
    killTree(proc.child.pid)
    await new Promise(done => { proc.child.once('close', done); setTimeout(done, 5000) })
  }
  return `${id} ${status(proc)}`
}

// A dropped connection must not leave servers running on this machine.
process.on('exit', () => {
  for (const p of procs.values()) if (p.code === undefined) killTree(p.child.pid, true)
  for (const child of foreground) killTree(child.pid, true)
})

// ---------- MCP over stdio ----------

const str = description => ({ type: 'string', description })
const num = description => ({ type: 'number', description })
const bool = description => ({ type: 'boolean', description })
const where = `Relative paths start at ${roots[0]}.`

const TOOLS = {
  ...desktopTools,
  read_file: {
    description: `Read a file. Text comes back as plain lines (UTF-8, UTF-16 and GBK are detected); PNG, JPEG, GIF and WebP come back as images. PDF defaults to a document; set pdf_format=text for agents that cannot open documents (needs pdftotext or Python pypdf on this machine). Long text is paginated with offset/limit. ${where}`,
    properties: { path: str('File to read'), offset: num('First line to return, starting at 1'), limit: num('Maximum number of lines, default 2000'), pdf_format: { type: 'string', enum: ['document', 'text'], description: 'PDF output, default document; text extraction happens on this machine' } },
    required: ['path'],
    run: readFile,
  },
  write_file: {
    description: 'Create a file, or replace the whole content of one you have already read with read_file. Missing folders are created. An existing file keeps its encoding and line endings.',
    properties: { path: str('File to write'), content: str('Full new content') },
    required: ['path', 'content'],
    run: writeFile,
  },
  edit_file: {
    description: 'Replace text in a file you have already read with read_file. old_string must match exactly and appear once, unless replace_all is set. Encoding and line endings are kept.',
    properties: { path: str('File to edit'), old_string: str('Exact text to replace'), new_string: str('Replacement text'), replace_all: bool('Replace every occurrence') },
    required: ['path', 'old_string', 'new_string'],
    run: editFile,
  },
  list_directory: {
    description: 'List the entries of one folder. Folders end with a slash.',
    properties: { path: str('Folder to list, default the root') },
    required: [],
    run: listDirectory,
  },
  find_files: {
    description: 'Find files by name with a glob such as **/*.ts or src/**/test_*.py, newest first. .git and node_modules are skipped unless the pattern names node_modules.',
    properties: { pattern: str('Glob, matched against the path relative to the search folder'), path: str('Folder to search, default the root') },
    required: ['pattern'],
    run: findFiles,
  },
  search_content: {
    description: 'Search file contents line by line with a JavaScript regular expression. Returns path:line:text. Skips .git, node_modules, binary files and files over 2 MB.',
    properties: {
      pattern: str('Regular expression, tested against each line'),
      path: str('File or folder to search, default the root'),
      glob: str('Only search files matching this glob, such as *.ts'),
      ignore_case: bool('Case-insensitive match'),
      files_only: bool('Return only the paths of files that match'),
      context: num('Lines of context to show around each match'),
      max_results: num('Stop after this many matches, default 100'),
    },
    required: ['pattern'],
    run: searchContent,
  },
  run_command: {
    description: `Run a shell command on this machine and return its exit code, output and errors. Each command starts in ${roots[0]} unless cwd is given; nothing carries over between calls. ${win ? 'The shell is PowerShell; set shell to cmd or bash for those.' : 'The shell is sh.'} Set background for servers and other long-running programs.`,
    properties: {
      command: str('Command line to run'),
      cwd: str('Folder to run in'),
      timeout_ms: num('Stop the command after this long, default 120000, at most 600000'),
      shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'], description: 'Shell to use on Windows' },
      background: bool('Start it and return at once; use process_output and stop_process afterwards'),
    },
    required: ['command'],
    run: runCommand,
  },
  process_output: {
    description: 'Show whether a background process is still running and its recent output. Without an id, list all background processes.',
    properties: { id: str('Id returned by run_command, such as p1') },
    required: [],
    run: processOutput,
  },
  stop_process: {
    description: 'Stop a background process and everything it started.',
    properties: { id: str('Id returned by run_command, such as p1') },
    required: ['id'],
    run: stopProcess,
  },
}

async function callTool(name, args) {
  const tool = TOOLS[name]
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  try {
    const missing = tool.required.find(k => args[k] === undefined || args[k] === null)
    if (missing) throw new Error(`Missing required argument: ${missing}`)
    const result = await tool.run(args)
    if (typeof result === 'string') return { content: [{ type: 'text', text: result }] }
    return Array.isArray(result) ? { content: result } : result
  } catch (e) {
    const text = e.code === 'ENOENT' ? `Not found: ${e.path ?? ''}` : String(e.message ?? e)
    return { content: [{ type: 'text', text }], isError: true }
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', async line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg?.id === undefined) return // notifications get no reply
  const reply = body => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }) + '\n')
  if (msg.method === 'initialize') {
    reply({ result: {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agentboat-hands', version: '0.2.0' },
      instructions: `These tools act on a remote machine. The project files are there, under: ${roots.join(', ')}. Use these tools for every file and command operation on that project.`,
    } })
  } else if (msg.method === 'ping') reply({ result: {} })
  else if (msg.method === 'tools/list') {
    const tools = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required } }))
    reply({ result: { tools } })
  } else if (msg.method === 'tools/call') reply({ result: await callTool(msg.params?.name, msg.params?.arguments ?? {}) })
  else reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } })
})
