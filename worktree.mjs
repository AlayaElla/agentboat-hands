#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim()
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

export function worktree(action, { repo, directory, branch, base = 'HEAD' }) {
  repo = fs.realpathSync.native(path.resolve(repo))
  if (action === 'list') return git(repo, ['worktree', 'list', '--porcelain'])
  if (!directory) throw new Error('An explicit worktree path is required.')
  directory = path.resolve(directory)
  if (action === 'create') {
    if (!branch || branch.startsWith('-') || base.startsWith('-')) throw new Error('create requires a branch and a base that do not start with an option.')
    git(repo, ['check-ref-format', '--branch', branch])
    if (fs.existsSync(directory)) throw new Error('Worktree path already exists; refusing to reuse it.')
    git(repo, ['worktree', 'add', '-b', branch, '--', directory, base])
    return `Created ${directory} on ${branch}. Start one hands instance with only this root.`
  }
  if (action !== 'remove') throw new Error('Action must be create, list or remove.')
  directory = fs.realpathSync.native(directory)
  const registered = git(repo, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').map(block => block.split('\0').find(row => row.startsWith('worktree '))?.slice(9)).filter(Boolean)
  const resolved = registered.filter(p => fs.existsSync(p)).map(p => fs.realpathSync.native(p))
  if (!resolved.some(p => same(p, directory)) || same(resolved[0], directory)) throw new Error('Only an explicitly registered linked worktree can be removed, never the main checkout.')
  // Git also refuses locked worktrees and nested submodules; never force or delete by filesystem.
  git(repo, ['worktree', 'remove', '--', directory])
  return `Removed ${directory}. Branch retained; merge/review it before deleting the branch.`
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [action, ...args] = process.argv.slice(2)
    const { values } = parseArgs({ args, options: { repo: { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' }, base: { type: 'string' } } })
    if (!values.repo) throw new Error('Usage: node worktree.mjs create|list|remove --repo <repository> [--path <new-worktree> --branch <unique-branch> --base HEAD]')
    console.log(worktree(action, { ...values, directory: values.path }))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
