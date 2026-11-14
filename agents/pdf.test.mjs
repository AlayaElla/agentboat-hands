import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { client } from './mcp-client.mjs'
import { pdfFixture } from './fixtures.mjs'

test('missing PDF dependencies fail clearly, while document attachment and root checks still work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-no-pdf-'))
  fs.writeFileSync(path.join(root, 'doc.pdf'), pdfFixture())
  const missing = path.join(root, 'missing-executable')
  const service = client({ command: process.execPath, args: [fileURLToPath(new URL('../hands.mjs', import.meta.url)), root], env: { HANDS_PDFTOTEXT: missing, HANDS_PDF_PYTHON: missing } })
  try {
    const result = await service.call('read_file', { path: 'doc.pdf', pdf_format: 'text' })
    assert.equal(result.isError, true)
    assert.match(result.text, /PDF text needs Poppler pdftotext, or Python with pypdf/)
    assert.equal((await service.call('read_file', { path: 'doc.pdf' })).content[0].resource.mimeType, 'application/pdf')
    assert.match((await service.call('read_file', { path: '../outside.pdf', pdf_format: 'text' })).text, /Outside the allowed folders/)
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
