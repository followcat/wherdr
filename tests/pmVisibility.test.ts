import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { apiUrl, ownLeakCheck, parseRemote, scanDiff, visibilityFromApi, visibilityFromGh } from '../shared/pm/visibility'
import { roleFiles } from '../shared/pm/coordinator'
import { instructionsText } from '../shared/pm/run'
import { reviewFile } from '../shared/pm/advance'
import { company } from '../shared/pm/examples'
import { REMOTE_SCRIPT, detectVisibility } from '../server/utils/pmVisibility'
import type { Project } from '../shared/pm/project'

describe('visibility detection', () => {
  it('reads the host and repository of a remote, credentials dropped', () => {
    expect(parseRemote('https://github.com/o/r.git')).toEqual({ host: 'github.com', path: 'o/r' })
    expect(parseRemote('https://user:secret@GitHub.com/o/r/')).toEqual({ host: 'github.com', path: 'o/r' })
    expect(parseRemote('git@github.com:o/r.git')).toEqual({ host: 'github.com', path: 'o/r' })
    expect(parseRemote('ssh://git@gitlab.com:22/group/sub/r.git')).toEqual({ host: 'gitlab.com', path: 'group/sub/r' })
    expect(parseRemote('/srv/git/r.git')).toBeNull()
    expect(parseRemote('')).toBeNull()
    expect(apiUrl({ host: 'gitlab.com', path: 'group/sub/r' })).toBe('https://gitlab.com/api/v4/projects/group%2Fsub%2Fr')
    expect(apiUrl({ host: 'bitbucket.org', path: 'o/r' })).toBe('https://api.bitbucket.org/2.0/repositories/o/r')
    expect(apiUrl({ host: 'git.example.com', path: 'o/r' })).toBeUndefined()
  })

  it('reads gh and the hosts\' API answers', () => {
    expect(visibilityFromGh('{"visibility":"PUBLIC"}')).toBe('public')
    expect(visibilityFromGh('{"visibility":"INTERNAL"}')).toBe('private')
    expect(visibilityFromGh('')).toBe('unknown')
    expect(visibilityFromApi(200, { private: false })).toBe('public') // GitHub
    expect(visibilityFromApi(200, { visibility: 'public' })).toBe('public') // GitLab
    expect(visibilityFromApi(200, { is_private: true })).toBe('private') // Bitbucket
    expect(visibilityFromApi(404, null)).toBe('private') // hidden without a login
    expect(visibilityFromApi(403, { message: 'rate limit' })).toBe('unknown')
  })

  const deps = (out: string, code = 0) => ({
    call: vi.fn(async (_m: string, p: { argv: string[] }) => (expect(p.argv[2]).toBe(REMOTE_SCRIPT), { code, stdout: Buffer.from(out).toString('base64') })),
    machines: () => [{ key: '', label: 'here', local: true, status: 'online' }],
  }) as never
  const p = { machine: '', path: '/src/web' }

  it('makes no network call without a remote, trusts gh, else asks the host\'s API', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ private: false }), { status: 200 }))
    expect(await detectVisibility(deps(''), p, fetcher)).toBe('unknown')
    expect(await detectVisibility(deps('https://github.com/o/r\n{"visibility":"PRIVATE"}'), p, fetcher)).toBe('private')
    expect(fetcher).not.toHaveBeenCalled()
    expect(await detectVisibility(deps('git@github.com:o/r.git'), p, fetcher)).toBe('public')
    expect(fetcher).toHaveBeenCalledWith('https://api.github.com/repos/o/r', expect.anything())
    expect(await detectVisibility(deps('git@git.example.com:o/r.git'), p, fetcher)).toBe('unknown')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(detectVisibility(deps('', 1), p, fetcher)).rejects.toThrow('git remote')
  })

  it('runs the real script: gh absent, logged out or not on GitHub leaves the host\'s API to answer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vis-'))
    // A PATH with git and the tools the script uses, no gh; then one with a gh that is logged out.
    const bin = join(root, 'bin'), out = join(root, 'out')
    mkdirSync(bin); mkdirSync(out)
    for (const tool of ['git', 'grep', 'head']) symlinkSync(execFileSync('sh', ['-c', `command -v ${tool}`]).toString().trim(), join(bin, tool))
    writeFileSync(join(out, 'gh'), '#!/bin/sh\necho "not logged in" >&2\nexit 4\n', { mode: 0o755 })
    const repo = (remote: string) => {
      const dir = mkdtempSync(join(root, 'r-'))
      execFileSync('git', ['init', '-q', dir])
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote])
      return { machine: '', path: dir }
    }
    const real = (path: string) => ({
      call: async (_m: string, q: { argv: string[] }) => {
        const r = spawnSync('/bin/sh', q.argv.slice(1), { env: { PATH: path, HOME: root } })
        return { code: r.status, stdout: r.stdout.toString('base64') }
      },
      machines: () => [{ key: '', label: 'here', local: true, status: 'online' }],
    }) as never
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ private: false, visibility: 'public' }), { status: 200 }))
    const github = repo('https://github.com/o/r.git'), gitlab = repo('git@gitlab.com:g/r.git')
    expect(await detectVisibility(real(bin), github, fetcher)).toBe('public') // no gh
    expect(await detectVisibility(real(`${out}:${bin}`), github, fetcher)).toBe('public') // gh logged out
    expect(await detectVisibility(real(`${out}:${bin}`), gitlab, fetcher)).toBe('public')
    expect(fetcher).toHaveBeenLastCalledWith('https://gitlab.com/api/v4/projects/g%2Fr', expect.anything())
    await expect(detectVisibility(real(bin), { machine: '', path: join(root, 'missing') }, fetcher)).rejects.toThrow('git remote')
  })
})

describe('leak checks', () => {
  it('finds the repo\'s own check', () => {
    expect(ownLeakCheck('{"scripts":{"test":"vitest","check:leaks":"node x"}}', [])).toBe('npm run check:leaks')
    expect(ownLeakCheck('', ['src', '.gitleaks.toml'])).toBe('gitleaks protect --staged')
    expect(ownLeakCheck('', ['.pre-commit-config.yaml'])).toBe('pre-commit run')
    expect(ownLeakCheck('', ['.git-hook'])).toBe('')
    expect(ownLeakCheck('not json', ['src'])).toBeUndefined()
  })

  it('scans the lines a diff adds, placeholders left alone', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1,4 @@',
      '-const old = "/home/jdoe/x"',
      '+const dir = "/home/jdoe/src"; const again = "/home/jdoe/y"',
      '+const ok = "/home/user/src" // user@example.com, git@github.com:o/r',
      '+const mail = "jane.doe@corp.io"',
      '+const t = "ghp_' + 'a'.repeat(36) + '"',
      '+++ b/key.pem', '+-----BEGIN OPENSSH PRIVATE KEY-----',
    ].join('\n')
    expect(scanDiff(diff)).toEqual([
      { file: 'a.ts', what: 'home path' }, { file: 'a.ts', what: 'e-mail address' }, { file: 'a.ts', what: 'token' },
      { file: 'key.pem', what: 'private key' },
    ])
    expect(scanDiff('+++ b/a.ts\n+const ok = "/home/user/src"\n-/home/jdoe')).toEqual([])
  })
})

describe('instructions of a public repository', () => {
  const project = (visibility?: Project['visibility']): Project => ({ key: 'CO', name: 'Company', machine: '', path: '/src/co', template: 'company', addedAt: 1, ...(visibility ? { visibility } : {}) })
  const pub = project({ value: 'public', at: 1, by: 'check' })
  const task = { id: 'CO-1', project: 'CO', title: 'T', description: 'D', type: Object.keys(company.taskTypes)[0]!, state: 'todo' as const, createdAt: 0 }
  const run = { worktree: '/w', branch: 'task/CO-1' }

  it('the coordinator, the worker and the reviewer get the rule; private or unknown, nothing changes', () => {
    expect(roleFiles(pub, company, [])['AGENTS.md']).toContain('## Public repository')
    expect(roleFiles(pub, company, [])['AGENTS.md']).toContain('each task description you write')
    for (const v of [undefined, { value: 'private', at: 1, by: 'user' }, { value: 'unknown', at: 1, by: 'check' }] as const) {
      expect(roleFiles(project(v), company, [])['AGENTS.md']).not.toContain('Public repository')
      expect(instructionsText(project(v), company, task, run)).not.toContain('Public repository')
    }
    expect(instructionsText(pub, company, task, run, undefined, 'npm run check:leaks')).toContain('Before each commit, run `npm run check:leaks`')
    expect(instructionsText(pub, company, task, run)).toContain('wherdr scans your diff')
    expect(reviewFile(task, run, 'Review it.', '/v.json', true)).toContain('any leak is a critical finding')
    expect(reviewFile(task, run, 'Review it.', '/v.json')).not.toContain('Public repository')
  })
})
