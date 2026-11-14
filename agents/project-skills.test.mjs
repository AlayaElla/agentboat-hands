import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { committedSkills, snapshotCommand, snapshotFiles, loadProjectSkills } from './project-skills.mjs'
import { generate, transport } from './generate.mjs'

test('committed reviewed skills survive SSH PowerShell transfer; all clients receive snapshots without native privileges', () => {
  const sandbox = path.resolve(process.env.AGENTBOAT_SANDBOX || path.join(os.tmpdir(), 'agentboat-sandbox'))
  fs.mkdirSync(sandbox, { recursive: true })
  const root = fs.mkdtempSync(path.join(sandbox, "agentboat-demo-snapshot-中文 '$x-"))
  const git = args => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' })
  const read = () => committedSkills(root, { fs, path, execFileSync, createHash })
  try {
    git(['init', '-q'])
    fs.mkdirSync(path.join(root, '.agents/skills/demo-check/references'), { recursive: true })
    fs.mkdirSync(path.join(root, '.agentboat/skill-proposals/draft'), { recursive: true })
    const content = '---\nname: demo-check\ndescription: Check the demo\n---\n\nReply SNAPSHOT_OK.\n'
    const resources = { 'SKILL.md': content, 'references/check.md': '中文 supporting file' }
    const hash = createHash('sha256')
    for (const [file, value] of Object.entries(resources).sort(([a], [b]) => a < b ? -1 : 1)) {
      fs.writeFileSync(path.join(root, '.agents/skills/demo-check', file), value)
      hash.update(file).update('\0').update(value).update('\0')
    }
    fs.writeFileSync(path.join(root, '.agentboat/skill-reviews.json'), JSON.stringify({ 'demo-check': { reviewer: 'project-main', source: 'test approval', sha256: hash.digest('hex') } }))
    fs.writeFileSync(path.join(root, '.agentboat/skill-proposals/draft/SKILL.md'), 'not approved')
    git(['add', '.']); git(['-c', 'user.name=AgentBoat Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'test skills', '--no-verify'])
    const snapshot = read()
    assert.deepEqual(snapshot.skills.map(s => s.name), ['demo-check'])
    fs.writeFileSync(path.join(root, '.agents/skills/demo-check/SKILL.md'), 'dirty content must not transfer')
    assert.deepEqual(read(), snapshot)
    if (process.platform === 'win32') {
      const encoded = snapshotCommand(root).split(' ').at(-1)
      const received = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true })
      assert.deepEqual(JSON.parse(received), snapshot)
      const shim = path.join(root, 'ssh-shim.cjs')
      fs.writeFileSync(shim, "const {execFileSync}=require('node:child_process');const encoded=process.argv.at(-1).split(' ').at(-1);process.stdout.write(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true}));")
      const server = transport({ ssh: 'test@windows', root, hands: 'D:/tools/hands.mjs' })
      assert.deepEqual(loadProjectSkills({ root, server: { command: process.execPath, args: [shim, ...server.args] } }), snapshot)
    }
    for (const agent of ['claude', 'codex', 'opencode']) {
      const directory = path.join(root, `host-${agent}`)
      const { files, launch } = generate({ agent, root, server: transport({ local: true, root }), directory, snapshot })
      assert.equal(files['.agents/skills/demo-check/SKILL.md'].toString(), content)
      assert.deepEqual(files['.claude/skills/demo-check/SKILL.md'], files['.agents/skills/demo-check/SKILL.md'])
      assert.match(files['project-skills.md'], /SNAPSHOT_OK/)
      if (agent === 'opencode') assert.ok(JSON.parse(files['opencode.json']).instructions.includes(path.join(directory, 'project-skills.md')))
      else assert.equal(launch.promptFile, path.join(directory, 'project-skills.md'))
      assert.match(files['remote-only.md'], /only through hands/)
      if (agent === 'codex') assert.ok(launch.args.includes('approval_policy="never"') && launch.args.includes('windows.sandbox="unelevated"'))
      fs.mkdirSync(directory)
      fs.writeFileSync(path.join(directory, 'project-skills.md'), files['project-skills.md'])
      if (agent === 'claude') {
        // Exercise the actual runner's stdin path without a model or a shell.
        fs.writeFileSync(path.join(directory, 'launch.json'), JSON.stringify({ command: process.execPath, args: ['-e', "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(s))"], cwd: directory, promptFile: launch.promptFile }))
        const result = execFileSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), directory, 'short task'], { encoding: 'utf8', windowsHide: true })
        assert.match(result, /SNAPSHOT_OK[\s\S]*Task:\nshort task/)
      }
    }
    assert.throws(() => snapshotFiles({ skills: [{ name: 'demo', files: { '../escape': '' } }] }, root), /Unsafe/)
    git(['add', '.agents']); git(['-c', 'user.name=AgentBoat Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'unreviewed change', '--no-verify'])
    assert.throws(read, /Unreviewed or changed/)
  } finally {
    assert.equal(path.dirname(root), sandbox)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
