// Drives the real server over stdio, the way an agent would. Run with: npm test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { pdfFixture } from './agents/fixtures.mjs'
import { client } from './agents/mcp-client.mjs'

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hands.mjs')
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hands-root-')))
const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hands-outside-')))
const f = (...parts) => path.join(root, ...parts)
const BOM8 = Buffer.from([0xef, 0xbb, 0xbf])
const BOM16 = Buffer.from([0xff, 0xfe])
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4] // "中文" in GBK

fs.writeFileSync(f('utf8.txt'), 'alpha\nbeta\nbeta\n中文\n')
fs.writeFileSync(f('crlf-bom.txt'), Buffer.concat([BOM8, Buffer.from('第一行 hello\r\n第二行 world\r\n')]))
fs.writeFileSync(f('utf16.txt'), Buffer.concat([BOM16, Buffer.from('中文\r\nsecond line\r\n', 'utf16le')]))
fs.writeFileSync(f('gbk.txt'), Buffer.concat([Buffer.from(GBK_ZHONGWEN), Buffer.from('\r\nsecond\r\n')]))
fs.writeFileSync(f('big.txt'), Array.from({ length: 5000 }, (_, i) => `row ${i + 1}`).join('\n') + '\n')
fs.writeFileSync(f('long.txt'), 'x'.repeat(100000) + '\nnext\n')
fs.writeFileSync(f('bin.dat'), Buffer.from([1, 2, 0, 3]))
fs.writeFileSync(f('pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
fs.writeFileSync(f('doc.pdf'), '%PDF-1.4\n%%EOF\n')
fs.writeFileSync(f('text.pdf'), pdfFixture(['PDF boat ticket: 7319', 'second line']))
fs.mkdirSync(f('sub', 'deep'), { recursive: true })
fs.writeFileSync(f('sub', 'deep', 'x.ts'), 'export const needle = 1\n')
fs.mkdirSync(f('node_modules', 'pkg'), { recursive: true })
fs.writeFileSync(f('node_modules', 'pkg', 'index.js'), 'const needle = 2\n')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n')
fs.symlinkSync(outside, f('link'), 'junction') // a link inside the root that points out of it

let child, rpc, call, close

const node = code => `node -e "${code}"`
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

before(async () => {
  ({ child, rpc, call, close } = client({ command: process.execPath, args: [server, root] }))
  const { result } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  assert.equal(result.protocolVersion, '2025-06-18')
})

after(async () => {
  await close()
  try { fs.rmdirSync(f('link')) } catch { /* not a junction on this platform */ }
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

test('requires an explicit root instead of exposing the working directory', () => {
  const result = spawnSync(process.execPath, [server], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage: node hands.mjs <root-folder>/)
  assert.equal(result.stdout, '')
})

test('null and malformed input do not break subsequent MCP requests', async () => {
  child.stdin.write('null\n{bad json\n')
  assert.deepEqual((await rpc('ping')).result, {})
})

test('offers the original nine tools and seven desktop tools', async () => {
  const { result } = await rpc('tools/list', {})
  assert.deepEqual(result.tools.map(t => t.name).sort(), [
    'edit_file', 'find_files', 'list_directory', 'process_output', 'read_file',
    'run_command', 'search_content', 'stop_process', 'write_file',
    'desktop_displays', 'desktop_windows', 'desktop_focus', 'desktop_screenshot', 'desktop_mouse', 'desktop_type', 'desktop_key',
  ].sort())
  assert.equal((await call('read_file', {})).text, 'Missing required argument: path')
})

test('reads UTF-8, UTF-16 and GBK text', async () => {
  assert.equal((await call('read_file', { path: 'utf8.txt' })).text, 'alpha\nbeta\nbeta\n中文')
  assert.equal((await call('read_file', { path: 'crlf-bom.txt' })).text, '第一行 hello\n第二行 world')
  assert.equal((await call('read_file', { path: 'utf16.txt' })).text, '中文\nsecond line')
  assert.equal((await call('read_file', { path: 'gbk.txt' })).text, '[GBK-encoded: can be read but not edited]\n中文\nsecond')
  assert.equal((await call('read_file', { path: 'missing.txt' })).isError, true)
})

test('returns long files in parts', async () => {
  const whole = (await call('read_file', { path: 'big.txt' })).text
  assert.match(whole, /^\[lines 1-2000 of 5000; continue with offset=2001\]\nrow 1\n/)
  assert.equal((await call('read_file', { path: 'big.txt', offset: 4999, limit: 5 })).text, '[lines 4999-5000 of 5000]\nrow 4999\nrow 5000')
  const long = (await call('read_file', { path: 'long.txt' })).text
  assert.match(long, /\[line cut here\]$/)
  assert.ok(long.length < 41000, 'one result stays under the size agents accept')
})

test('returns images and PDFs as media, refuses other binary', async () => {
  const image = (await call('read_file', { path: 'pic.png' })).content[0]
  assert.deepEqual([image.type, image.mimeType], ['image', 'image/png'])
  assert.equal((await call('read_file', { path: 'doc.pdf' })).content[0].resource.mimeType, 'application/pdf')
  assert.match((await call('read_file', { path: 'bin.dat' })).text, /Binary file/)
})

test('PDF text mode extracts with the optional adapter or explains the missing dependency, without changing document mode', async () => {
  const result = await call('read_file', { path: 'text.pdf', pdf_format: 'text' })
  if (result.isError) {
    assert.match(result.text, /PDF text needs Poppler pdftotext, or Python with pypdf/)
    assert.ok(!process.env.HANDS_PDF_PYTHON, 'an explicitly configured PDF adapter must work')
  } else {
    assert.match(result.text, /PDF boat ticket: 7319/)
    assert.match((await call('read_file', { path: 'text.pdf', pdf_format: 'text', offset: 2, limit: 1 })).text, /second line/)
  }
  assert.equal((await call('read_file', { path: 'text.pdf' })).content[0].resource.mimeType, 'application/pdf')
  assert.equal((await call('read_file', { path: 'text.pdf', pdf_format: 'invalid' })).isError, true)
  assert.match((await call('read_file', { path: 'doc.pdf', pdf_format: 'text' })).text, /PDF extraction failed|PDF text needs/)
  assert.match((await call('read_file', { path: path.join(outside, 'secret.pdf'), pdf_format: 'text' })).text, /Outside the allowed folders/)
})

test('stays inside its root folder', async () => {
  const escapes = [path.join(outside, 'secret.txt'), `../${path.basename(outside)}/secret.txt`, 'link/secret.txt']
  for (const p of escapes) {
    const r = await call('read_file', { path: p })
    assert.equal(r.isError, true, p)
    assert.match(r.text, /Outside the allowed folders/, p)
  }
  assert.equal((await call('write_file', { path: path.join(outside, 'new.txt'), content: 'x' })).isError, true)
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false)
  assert.match((await call('run_command', { command: 'echo hi', cwd: outside })).text, /Outside the allowed folders/)
})

test('write_file refuses a dangling file symlink to outside the root', async t => {
  const target = path.join(outside, 'dangling-target.txt')
  try { fs.symlinkSync(target, f('dangling-file'), 'file') } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`File symlinks unavailable (${error.code}); requires Windows Developer Mode or symlink privilege.`); return }
    throw error
  }
  const result = await call('write_file', { path: 'dangling-file', content: 'must not escape' })
  assert.equal(result.isError, true)
  assert.equal(fs.existsSync(target), false)
  assert.ok(fs.lstatSync(f('dangling-file')).isSymbolicLink())
})

test('write_file refuses a path below a dangling directory link', async () => {
  const target = path.join(outside, 'missing-directory')
  fs.symlinkSync(target, f('dangling-directory'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await call('write_file', { path: 'dangling-directory/new.txt', content: 'must not escape' })
  assert.equal(result.isError, true)
  assert.equal(fs.existsSync(target), false)
})

test('refuses to change a file it has not read, or one that changed since', async () => {
  fs.writeFileSync(f('guard.txt'), 'one\n')
  assert.match((await call('write_file', { path: 'guard.txt', content: 'two\n' })).text, /Read this file/)
  assert.match((await call('edit_file', { path: 'guard.txt', old_string: 'one', new_string: 'two' })).text, /Read this file/)
  await call('read_file', { path: 'guard.txt' })
  fs.writeFileSync(f('guard.txt'), 'changed elsewhere\n')
  fs.utimesSync(f('guard.txt'), new Date(), new Date(Date.now() + 5000))
  assert.match((await call('edit_file', { path: 'guard.txt', old_string: 'changed', new_string: 'x' })).text, /changed since/)
  assert.equal(fs.readFileSync(f('guard.txt'), 'utf8'), 'changed elsewhere\n')
})

test('edits exactly and keeps encoding and line endings', async () => {
  await call('read_file', { path: 'utf8.txt' })
  assert.match((await call('edit_file', { path: 'utf8.txt', old_string: 'beta', new_string: 'B' })).text, /appears 2 times/)
  assert.match((await call('edit_file', { path: 'utf8.txt', old_string: 'nope', new_string: 'x' })).text, /not found/)
  assert.match((await call('edit_file', { path: 'utf8.txt', old_string: 'beta', new_string: '$& B', replace_all: true })).text, /Replaced 2/)
  assert.equal(fs.readFileSync(f('utf8.txt'), 'utf8'), 'alpha\n$& B\n$& B\n中文\n')

  await call('read_file', { path: 'crlf-bom.txt' })
  await call('edit_file', { path: 'crlf-bom.txt', old_string: 'hello\n第二行', new_string: 'HELLO\n第二行' })
  assert.deepEqual(fs.readFileSync(f('crlf-bom.txt')), Buffer.concat([BOM8, Buffer.from('第一行 HELLO\r\n第二行 world\r\n')]))

  await call('read_file', { path: 'utf16.txt' })
  await call('edit_file', { path: 'utf16.txt', old_string: 'second', new_string: 'SECOND' })
  assert.deepEqual(fs.readFileSync(f('utf16.txt')), Buffer.concat([BOM16, Buffer.from('中文\r\nSECOND line\r\n', 'utf16le')]))

  await call('read_file', { path: 'gbk.txt' })
  assert.match((await call('edit_file', { path: 'gbk.txt', old_string: 'second', new_string: 'x' })).text, /GBK-encoded/)
  assert.deepEqual([...fs.readFileSync(f('gbk.txt')).subarray(0, 4)], GBK_ZHONGWEN)

  assert.match((await call('write_file', { path: 'made/new/file.txt', content: 'hi\n' })).text, /Wrote/)
  assert.equal(fs.readFileSync(f('made', 'new', 'file.txt'), 'utf8'), 'hi\n')
})

test('finds files and searches content, GBK included', async () => {
  assert.equal((await call('find_files', { pattern: '**/*.ts' })).text, 'sub/deep/x.ts')
  assert.equal((await call('find_files', { pattern: '*.ts' })).text, 'No files matched.')
  assert.equal((await call('find_files', { pattern: 'node_modules/**/*.js' })).text, 'node_modules/pkg/index.js')
  assert.equal((await call('search_content', { pattern: 'needle' })).text, 'sub/deep/x.ts:1:export const needle = 1')
  assert.equal((await call('search_content', { pattern: 'NEEDLE', ignore_case: true, files_only: true })).text, 'sub/deep/x.ts')
  assert.match((await call('search_content', { pattern: '中文', glob: '*.txt', files_only: true })).text, /^gbk\.txt$/m)
  assert.equal((await call('search_content', { pattern: 'row 4999', path: 'big.txt', context: 1 })).text,
    'big.txt:4998-row 4998\nbig.txt:4999:row 4999\nbig.txt:5000-row 5000\n--')
  assert.match((await call('list_directory')).text, /^sub\/$/m)
})

test('brace globs compile each wildcard alternative for find and search', async () => {
  for (const name of ['alpha.test.mjs', 'beta.spec.mjs', 'gamma.mjs', 'literal[1].test.mjs']) fs.writeFileSync(f(name), 'brace needle\n')
  const expected = ['alpha.test.mjs', 'beta.spec.mjs', 'literal[1].test.mjs']
  assert.deepEqual((await call('find_files', { pattern: '{*.test.mjs,*.spec.mjs}' })).text.split('\n').sort(), expected)
  assert.deepEqual((await call('search_content', { pattern: 'brace needle', glob: '{*.test.mjs,*.spec.mjs}', files_only: true })).text.split('\n').sort(), expected)
  assert.equal((await call('find_files', { pattern: '{literal[1].test.mjs,missing?.mjs}' })).text, 'literal[1].test.mjs')
})

test('runs commands: exit code, stderr, Chinese and GBK output, working folder, timeout', async () => {
  const failed = await call('run_command', { command: node("console.log('out'); console.error('err'); process.exit(3)") })
  assert.equal(failed.isError, true)
  assert.equal(failed.text, 'exit code: 3\nout\n[stderr]\nerr')
  assert.equal((await call('run_command', { command: node("console.log('中文输出')") })).text, 'exit code: 0\n中文输出')
  assert.equal((await call('run_command', { command: node('process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))') })).text, 'exit code: 0\n中文')
  assert.equal((await call('run_command', { command: node('console.log(process.cwd())'), cwd: 'sub' })).text, `exit code: 0\n${f('sub')}`)
  const started = Date.now()
  assert.match((await call('run_command', { command: node('setTimeout(()=>{},30000)'), timeout_ms: 500 })).text, /timed out/)
  assert.ok(Date.now() - started < 10000, 'a timed-out command is stopped, not waited for')
})

test('reports missing or non-directory command working folders before spawning a shell', async () => {
  for (const background of [false, true]) {
    const missing = await call('run_command', { command: 'echo must-not-run', cwd: 'missing-cwd', background })
    assert.equal(missing.isError, true)
    assert.match(missing.text, /Working directory does not exist/)
    const file = await call('run_command', { command: 'echo must-not-run', cwd: 'utf8.txt', background })
    assert.equal(file.isError, true)
    assert.match(file.text, /Working directory is not a folder/)
  }
})

test('caps stdout and stderr separately while draining large command output', async () => {
  const result = await call('run_command', { command: node("process.stdout.write('x'.repeat(3*1024*1024)+'STDOUT_END'); process.stderr.write('y'.repeat(3*1024*1024)+'STDERR_END')") })
  assert.equal(result.isError, false)
  assert.match(result.text, /stdout truncated at 2097152 bytes/)
  assert.match(result.text, /stderr truncated at 2097152 bytes/)
  assert.doesNotMatch(result.text, /STDOUT_END|STDERR_END/)
  assert.ok(result.text.length < 31000)
  assert.deepEqual((await rpc('ping')).result, {})
})

test('can use cmd on Windows', { skip: process.platform !== 'win32' }, async () => {
  assert.equal((await call('run_command', { command: 'echo hello-from-cmd', shell: 'cmd' })).text, 'exit code: 0\nhello-from-cmd')
})

// Must stay last: it ends by closing the connection.
test('background processes: output, stop, and cleanup when the connection closes', async () => {
  const ticker = name => node(`require('fs').writeFileSync('${name}', String(process.pid)); setInterval(()=>console.log('tick'),100)`)
  const id = (await call('run_command', { command: ticker('a.pid'), background: true })).text.match(/Started (p\d+)/)[1]
  assert.ok(await until(async () => /^running\n(tick\n?)+/.test((await call('process_output', { id })).text)), 'output is readable while it runs')
  const pidA = Number(fs.readFileSync(f('a.pid'), 'utf8'))
  assert.match((await call('process_output')).text, new RegExp(`^${id}  running`))
  assert.match((await call('stop_process', { id })).text, /exited/)
  assert.ok(await until(() => !alive(pidA)), 'stop_process ends the whole process tree')

  await call('run_command', { command: ticker('b.pid'), background: true })
  assert.ok(await until(() => fs.existsSync(f('b.pid'))))
  const pidB = Number(fs.readFileSync(f('b.pid'), 'utf8'))
  child.stdin.end() // the agent disconnects
  assert.ok(await until(() => !alive(pidB)), 'closing the connection ends what it started')
})
