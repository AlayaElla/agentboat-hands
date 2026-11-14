import fs from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'

export function pdfFixture(lines = ['PDF boat ticket: 7319']) {
  const content = `BT /F1 18 Tf 50 750 Td ${lines.map((line, i) => `${i ? '0 -20 Td ' : ''}(${line.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n')} ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n', offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')
  return pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

function redPng() {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data])
    let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2
  const pixels = Buffer.alloc(64 * (1 + 64 * 3))
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

export function fixtures(root) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'utf8.txt'), 'Boat UTF8: 中文\n')
  fs.writeFileSync(path.join(root, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
  fs.writeFileSync(path.join(root, 'doc.pdf'), pdfFixture())
  fs.writeFileSync(path.join(root, 'red.png'), redPng())
  fs.writeFileSync(path.join(root, 'edit.txt'), 'before\n')
  fs.writeFileSync(path.join(root, 'verify.cjs'), "const fs=require('node:fs'); if(fs.readFileSync('edit.txt','utf8').trim()!=='after')process.exit(3);console.log('EDIT_OK')\n")
  fs.writeFileSync(path.join(root, 'ticker.cjs'), "console.log('BOAT_TICK');setInterval(()=>console.log('BOAT_TICK'),300)\n")
}
