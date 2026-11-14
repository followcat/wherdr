import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareWorktree } from '../server/utils/pmDeps'
import { validateTemplate, type Template, type WorktreeSetup } from '../shared/pm/workflow'

// The real scripts, on a clone and a git worktree of it, through a machine.exec run here.
let dir = '', repo = '', wt = ''
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-setup-'))
  repo = path.join(dir, 'repo'); wt = path.join(dir, 'wt')
  await fs.mkdir(path.join(repo, 'node_modules', 'left-pad'), { recursive: true })
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules\n.env\n')
  await fs.writeFile(path.join(repo, 'package-lock.json'), '{"v":1}')
  await fs.writeFile(path.join(repo, 'tracked.json'), 'in git')
  git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'x')
  git(repo, 'worktree', 'add', '-q', wt)
  await fs.writeFile(path.join(repo, '.env'), 'KEY=1')
  await fs.writeFile(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'main')
  await fs.writeFile(path.join(repo, 'node_modules', '.package-lock.json'), '{}')
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const deps = {
  call: async (_m: string, p: Record<string, unknown>) => {
    const [cmd, ...args] = p.argv as string[]
    const r = spawnSync(cmd!, args, { timeout: (p.timeout as number) * 1000 })
    return { code: r.status, stdout: r.stdout.toString('base64'), timed_out: r.signal !== null }
  },
} as never
const t = (worktree?: WorktreeSetup): Template => ({ id: 'x', taskTypes: { a: { steps: [{ id: 'w' }] } }, ...(worktree ? { worktree } : {}) })
const prepare = (w?: WorktreeSetup) => prepareWorktree(deps, undefined, repo, wt, t(w))

describe('worktree setup', () => {
  it('copies ignored files from the clone, skips tracked and missing ones, and logs it', async () => {
    const r = await prepare({ copy: ['.env', 'tracked.json', 'config.local.json'] })
    expect(await fs.readFile(path.join(wt, '.env'), 'utf8')).toBe('KEY=1')
    expect(r.log).toBe('worktree setup: copied .env; not copied tracked.json (tracked by git), config.local.json (not in the clone); shared node_modules from the clone')
    expect(r.note).toMatch(/^Worktree setup done by wherdr: \.env copied from the clone; node_modules shared from the clone\. Do not reinstall/)
    // A second start: nothing new to log, the worker still told.
    expect((await prepare({ copy: ['.env'] })).log).toBe('')
  })

  it('shares a folder only while the lockfile matches the clone\'s, else runs the command once', async () => {
    const w = { command: 'mkdir node_modules && echo installed > node_modules/x', lockfile: 'package-lock.json' }
    expect((await prepare(w)).log).toBe('worktree setup: shared node_modules from the clone')
    // The copy is the worktree's own: writing into it leaves the clone's alone.
    await fs.writeFile(path.join(wt, 'node_modules', 'left-pad', 'index.js'), 'patched')
    expect(await fs.readFile(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('main')

    await fs.rm(path.join(wt, 'node_modules'), { recursive: true })
    await fs.writeFile(path.join(wt, 'package-lock.json'), '{"v":2}') // the task changed it
    const r = await prepare(w)
    expect(r.log).toMatch(/^worktree setup: not shared node_modules \(package-lock\.json differs from the clone's\); ran mkdir node_modules .* \(\d+ s\)$/)
    expect(r.note).toContain('`mkdir node_modules && echo installed > node_modules/x` ran')
    expect(r.failed).toBeUndefined()
    expect(await fs.readFile(path.join(wt, 'node_modules', 'x'), 'utf8')).toBe('installed\n')
    expect((await prepare(w)).log).toBe('') // kept, not run again
  })

  it('a failing command: why, with its last output, and it runs again at the next start', async () => {
    const w = { share: [], command: 'echo resolving; echo "npm ERR! boom" >&2; exit 3' }
    const r = await prepare(w)
    expect(r.failed).toBe('The worktree setup command failed: `echo resolving; echo "npm ERR! boom" >&2; exit 3` exited with code 3. Last output:\nresolving\nnpm ERR! boom')
    expect(r.log).toBe(`worktree setup: ran ${w.command} (exit code 3)`)
    expect((await prepare(w)).failed).toBeDefined()
    expect((await prepare({ share: [], command: 'true' })).log).toMatch(/ran true/)
    expect((await prepare({ share: [], command: 'true' })).log).toBe('') // succeeded once: not again
  })

  it('no block in a project without package-lock.json: nothing said', async () => {
    await fs.rm(path.join(wt, 'package-lock.json'))
    expect(await prepare()).toEqual({ log: '', note: undefined })
  })

  it('checks the block in the workflow', () => {
    expect(validateTemplate(t({ copy: ['../x', '*.env', '/etc/passwd'], share: ['node_modules'], timeout: '2h', extra: 1 } as never)).map(e => e.path))
      .toEqual(['worktree.extra', 'worktree.copy', 'worktree.timeout'])
    expect(validateTemplate(t({ copy: ['.env', 'config/local.json'], lockfile: 'pnpm-lock.yaml', command: 'pnpm i', timeout: '5m' }))).toEqual([])
  })
})
