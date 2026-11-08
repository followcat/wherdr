import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEPS_SCRIPT, depsNote } from '../server/utils/pmDeps'

// The real script, on a fake main checkout and a fake new worktree.
let dir = '', repo = '', wt = ''
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-deps-'))
  repo = path.join(dir, 'repo'); wt = path.join(dir, 'wt')
  await fs.mkdir(path.join(repo, 'node_modules', 'left-pad'), { recursive: true })
  await fs.mkdir(wt)
  await fs.writeFile(path.join(repo, 'package-lock.json'), '{"v":1}')
  await fs.writeFile(path.join(wt, 'package-lock.json'), '{"v":1}')
  await fs.writeFile(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'main')
  await fs.writeFile(path.join(repo, 'node_modules', '.package-lock.json'), '{}')
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))
const run = () => execFileSync('sh', ['-c', DEPS_SCRIPT, 'sh', repo, wt]).toString().trim()

describe('task worktree dependencies', () => {
  it('same lock: a copy of the main install, which a task writing into it leaves alone', async () => {
    expect(run()).toBe('shared')
    const copied = path.join(wt, 'node_modules', 'left-pad', 'index.js')
    expect(await fs.readFile(copied, 'utf8')).toBe('main')
    await fs.writeFile(copied, 'patched')
    expect(await fs.readFile(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('main')
    expect(run()).toBe('kept') // a second start keeps the worktree's own
  })

  it('a different lock, or a main checkout without an install matching it: npm ci', async () => {
    await fs.writeFile(path.join(wt, 'package-lock.json'), '{"v":2}')
    expect(run()).toBe('install')
    await fs.writeFile(path.join(wt, 'package-lock.json'), '{"v":1}')
    await fs.rm(path.join(repo, 'node_modules', '.package-lock.json'))
    expect(run()).toBe('install')
    await fs.rm(path.join(repo, 'node_modules'), { recursive: true })
    expect(run()).toBe('install')
    await expect(fs.stat(path.join(wt, 'node_modules'))).rejects.toThrow()
  })

  it('tells the worker, and says nothing when the script did not answer', () => {
    expect(depsNote('shared')).toMatch(/installed.*Run npm ci only if package-lock.json changes/)
    expect(depsNote('install')).toMatch(/^Run npm ci first/)
    expect(depsNote('none')).toBeUndefined()
    expect(depsNote('')).toBeUndefined()
  })
})
