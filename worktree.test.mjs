import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { worktree } from './worktree.mjs'
import { client } from './agents/mcp-client.mjs'

test('two simultaneous hands instances edit the same file in separate worktrees; cleanup preserves dirty work', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-worktrees-'))
  const repo = path.join(temp, 'repo'), a = path.join(temp, 'agent-a'), b = path.join(temp, 'agent-b')
  fs.mkdirSync(repo)
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let first, second
  try {
    git(['init'])
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'original\n')
    git(['add', 'shared.txt'])
    git(['-c', 'user.name=Hands test', '-c', 'user.email=hands@example.invalid', '-c', 'core.hooksPath=', 'commit', '-m', 'fixture'])
    worktree('create', { repo, directory: a, branch: 'test/agent-a' })
    worktree('create', { repo, directory: b, branch: 'test/agent-b' })
    const hands = fileURLToPath(new URL('./hands.mjs', import.meta.url))
    first = client({ command: process.execPath, args: [hands, a] })
    second = client({ command: process.execPath, args: [hands, b] })
    await Promise.all([first.call('read_file', { path: 'shared.txt' }), second.call('read_file', { path: 'shared.txt' })])
    const edits = await Promise.all([
      first.call('edit_file', { path: 'shared.txt', old_string: 'original', new_string: 'agent-a' }),
      second.call('edit_file', { path: 'shared.txt', old_string: 'original', new_string: 'agent-b' }),
    ])
    assert.ok(edits.every(r => !r.isError))
    const results = await Promise.all([first.call('read_file', { path: 'shared.txt' }), second.call('read_file', { path: 'shared.txt' })])
    assert.deepEqual(results.map(r => r.text), ['agent-a', 'agent-b'])
    assert.equal(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), 'original\n')
    assert.equal((await first.call('read_file', { path: path.join(b, 'shared.txt') })).isError, true)
    assert.throws(() => worktree('remove', { repo, directory: a }))
    assert.throws(() => worktree('remove', { repo, directory: repo }), /main checkout/)
    assert.throws(() => worktree('create', { repo, directory: a, branch: 'test/other' }), /already exists/)
    assert.throws(() => worktree('create', { repo, directory: path.join(temp, 'bad'), branch: '--force' }), /branch/)
    // Restore only the known fixture files so normal git worktree remove can demonstrate clean removal.
    for (const directory of [a, b]) execFileSync('git', ['-C', directory, 'restore', '--source=HEAD', '--worktree', '--', 'shared.txt'], { windowsHide: true })
    await Promise.all([first.close(), second.close()]); first = second = undefined
    // A manually deleted sibling must not prevent removing a remaining registered worktree.
    assert.equal(path.dirname(a), temp)
    fs.rmSync(a, { recursive: true })
    worktree('remove', { repo, directory: b })
    assert.ok(!fs.existsSync(a) && !fs.existsSync(b))
    assert.match(worktree('list', { repo }), /worktree /)
    assert.match(git(['branch', '--list']), /test\/agent-a/)
  } finally {
    if (first) await first.close()
    if (second) await second.close()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
