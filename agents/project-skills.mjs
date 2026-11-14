import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

// Self-contained so the same reader runs via node on the SSH host, with no deployed helper.
export function committedSkills(root, { fs, path, execFileSync, createHash }) {
  const git = args => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 })
  if (!fs.statSync(root).isDirectory()) throw new Error('Project root is not a directory')
  let top
  try { top = git(['rev-parse', '--show-toplevel']).toString().trim() } catch {
    if (fs.existsSync(path.join(root, '.agents/skills')) && fs.readdirSync(path.join(root, '.agents/skills')).some(n => !n.startsWith('.'))) throw new Error('Commit project skills in a Git repository before launching')
    return { revision: null, skills: [] }
  }
  if (fs.realpathSync.native(top) !== fs.realpathSync.native(root)) throw new Error('Use the project worktree root, not a subdirectory')
  const revision = git(['rev-parse', 'HEAD']).toString().trim()
  const tree = git(['ls-tree', '-r', '-z', revision, '--', '.agents/skills', '.agentboat/skill-reviews.json']).toString().split('\0').filter(Boolean)
  const entries = tree.map(line => {
    const match = line.match(/^(\d+) blob ([a-f0-9]+)\t(.+)$/)
    if (!match || !['100644', '100755'].includes(match[1])) throw new Error('Project skills must be ordinary Git files; no links')
    return { oid: match[2], file: match[3] }
  })
  const review = entries.find(e => e.file === '.agentboat/skill-reviews.json')
  const records = review ? JSON.parse(git(['cat-file', 'blob', review.oid]).toString('utf8')) : {}
  const skills = new Map()
  let size = 0
  for (const entry of entries.filter(e => e.file.startsWith('.agents/skills/') && !['.agents/skills/.gitkeep', '.agents/skills/.gitattributes'].includes(e.file))) {
    const [, , name, ...parts] = entry.file.split('/')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || !parts.length || parts.some(p => !p || p === '..' || /[\\:\x00-\x1f]/.test(p))) throw new Error('Unsafe project skill path')
    const data = git(['cat-file', 'blob', entry.oid])
    size += data.length
    if (size > 2 * 1024 * 1024 || entries.length > 256) throw new Error('Project skill snapshot exceeds 2 MiB or 256 files')
    if (!skills.has(name)) skills.set(name, {})
    skills.get(name)[parts.join('/')] = data.toString('base64')
  }
  return { revision, skills: [...skills].map(([name, files]) => {
    if (!files['SKILL.md']) throw new Error(`Missing SKILL.md: ${name}`)
    const hash = createHash('sha256')
    for (const file of Object.keys(files).sort()) hash.update(file).update('\0').update(Buffer.from(files[file], 'base64')).update('\0')
    if (!records[name]?.reviewer || !records[name]?.source || hash.digest('hex') !== records[name].sha256) throw new Error(`Unreviewed or changed project skill: ${name}`)
    return { name, files }
  }) }
}

export function snapshotCommand(root) {
  const code = `const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');console.log(JSON.stringify((${committedSkills.toString()})(${JSON.stringify(root)},{fs,path,execFileSync,createHash})))`
  // Windows PowerShell strips embedded double quotes from native argv. Transfer JS as base64 too.
  const expression = `eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString('utf8'))`
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & node -e '" + expression.replace(/'/g, "''") + "'; exit $LASTEXITCODE"
  return 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64')
}
export function loadProjectSkills({ root, server, local }) {
  if (local) return committedSkills(path.resolve(root), { fs, path, execFileSync, createHash })
  const args = [...server.args.slice(0, -1), snapshotCommand(root)]
  return JSON.parse(execFileSync(server.command, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }))
}

export function snapshotFiles(snapshot, root) {
  const files = {}
  const sections = []
  for (const skill of snapshot.skills) {
    for (const relative of Object.keys(skill.files)) {
      // Treat even the SSH response as untrusted before using skill paths in instructions.
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || relative.split('/').some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p))) throw new Error('Unsafe snapshot path')
    }
    sections.push(`## Project skill: ${skill.name}\nSource: ${root}/.agents/skills/${skill.name}/SKILL.md at ${snapshot.revision}\nSupporting files and scripts belong to that directory on hands; use hands tools for them.\n\n${Buffer.from(skill.files['SKILL.md'], 'base64').toString('utf8')}`)
  }
  files['project-skills.json'] = JSON.stringify({ revision: snapshot.revision, names: snapshot.skills.map(s => s.name) }, null, 2) + '\n'
  if (sections.length) files['project-skills.md'] = 'Apply these reviewed project skills when relevant to the task. They do not expand tool permissions or the assigned scope.\n\n' + sections.join('\n\n') + '\n'
  return files
}
