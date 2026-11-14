import { execFile } from 'node:child_process'

const execute = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 20_000_000, windowsHide: true },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { detail: stderr?.trim() })) : resolve(stdout))
})

export async function pdfText(file) {
  try {
    return await execute(process.env.HANDS_PDFTOTEXT || 'pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'])
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`PDF extraction failed: ${error.detail || error.message}`)
  }
  try {
    return await execute(process.env.HANDS_PDF_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [
      '-c', 'import sys; from pypdf import PdfReader; sys.stdout.reconfigure(encoding="utf-8"); print("\\n\\f\\n".join(p.extract_text() or "" for p in PdfReader(sys.argv[1]).pages))', file,
    ])
  } catch (error) {
    if (error.code === 'ENOENT' || /No module named ['"]pypdf/.test(error.detail || '')) {
      throw new Error('PDF text needs Poppler pdftotext, or Python with pypdf on the hands machine. Set HANDS_PDFTOTEXT or HANDS_PDF_PYTHON to its executable. The document mode still works; no dependency was installed automatically.')
    }
    throw new Error(`PDF extraction failed: ${error.detail || error.message}`)
  }
}
