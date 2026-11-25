import { describe, expect, it, vi } from 'vitest'
import { readyOf, readyRefusal, sameRepo } from '../shared/pm/ready'
import { ensureReady, readiness } from '../server/utils/pmReady'
import type { PmLaunchDeps } from '../server/utils/pmLaunch'
import type { Project } from '../shared/pm/project'
import type { Task } from '../shared/pm/run'
import type { Template } from '../shared/pm/workflow'

vi.mock('../server/utils/settings', () => ({ namedAgents: async () => [] }))

const ORIGIN = 'https://github.com/owner/project.git'
const READY = `clone ok git@github.com:owner/project.git
fetch ok
push ok
node ok v22.3.0 want=>=20
npm ok 10.8.0
deps warn not installed in the clone: each task runs npm ci
agent:claude ok {"loggedIn": true}
pm ok
disk ok 20971520
not a check line`

describe('readyOf', () => {
  it('reads a ready machine: a warning does not refuse, unknown lines are skipped', () => {
    const r = readyOf(READY, ORIGIN, 1)
    expect(r.items.map(i => i.id)).toEqual(['clone', 'fetch', 'push', 'node', 'npm', 'deps', 'agent:claude', 'pm', 'disk'])
    expect(r.items.find(i => i.id === 'disk')!.detail).toBe('20.0 GB free')
    expect(r.items.find(i => i.id === 'deps')).toMatchObject({ ok: true, warn: true })
    expect(readyRefusal(r)).toBeUndefined()
  })

  it('names every failed check: another repo, an old node, a logged-out agent, a full disk', () => {
    const out = `clone ok https://github.com/someone/else
push fail fatal: Authentication failed
node ok v18.19.0 want=22
agent:codex fail Not logged in
agent:claude fail claude is not installed
disk ok 1048576`
    expect(readyRefusal(readyOf(out, ORIGIN))).toBe([
      `clone: its origin is https://github.com/someone/else, not the project's ${ORIGIN}`,
      'push rights: fatal: Authentication failed',
      'node: v18.19.0, the project wants 22',
      'codex login: not logged in',
      'claude login: claude is not installed',
      'disk space: 1.0 GB free, 5 GB needed',
    ].join('; '))
  })

  it('names a missing browser relay as a machine problem', () => {
    const r = readyOf('clone ok https://github.com/owner/project\nrelay fail the omp browser relay\'s native host is not registered in Chrome', ORIGIN)
    expect(readyRefusal(r)).toBe('browser relay: the omp browser relay\'s native host is not registered in Chrome')
  })

  it('refuses when the script printed nothing, or the disk could not be read', () => {
    expect(readyRefusal(readyOf('', ORIGIN))).toBe('the check could not run')
    expect(readyRefusal(readyOf('disk ok ', ORIGIN))).toBe('disk space: free space unknown')
  })
})

describe('sameRepo', () => {
  it('matches https, ssh and scp-like forms of one repository', () => {
    for (const u of ['git@github.com:Owner/project', 'ssh://git@github.com/owner/project.git', 'https://user@github.com/owner/project/'])
      expect(sameRepo(u, ORIGIN)).toBe(true)
    expect(sameRepo('https://github.com/owner/other', ORIGIN)).toBe(false)
    expect(sameRepo('', '')).toBe(false)
  })
})

describe('ensureReady', () => {
  const template = { id: 't', prefs: { agent: 'claude', model: 'sonnet' }, taskTypes: { work: { steps: [{ id: 'work', holder: 'worker', ends: 'report' }] } } } as unknown as Template
  const project = { key: 'PRJ', name: 'Project', machine: '', path: '/work/project' } as Project
  const plain = { type: 'work' } as Task
  const relay = { type: 'work', prefs: { browser: 'relay' } } as Task

  // A machine whose relay is not registered: the script's relay argument decides what it prints.
  function setup() {
    const checks: string[] = []
    const call = async (_: string, p: { argv: string[] }) => {
      const isReady = p.argv[2]!.includes('relay=$6')
      if (isReady) checks.push(p.argv[9]!)
      const lines = isReady ? `clone ok ${ORIGIN}\n${p.argv[9] === '1' ? 'relay fail not registered' : ''}` : ORIGIN
      return { code: 0, stdout: Buffer.from(lines).toString('base64') }
    }
    const deps = { call, machines: () => [{ key: '', label: 'Home', local: true, status: 'online' }, { key: 'm', label: 'M', local: true, status: 'online' }] } as unknown as PmLaunchDeps
    return { deps, checks }
  }

  it('checks the relay for a relay task although a task without it passed on the machine a moment ago', async () => {
    const { deps, checks } = setup()
    await ensureReady(deps, project, template, plain, 'm', '/work/project')
    await expect(ensureReady(deps, project, template, relay, 'm', '/work/project')).rejects.toThrow('browser relay: not registered')
    expect(checks).toEqual(['0', '1'])
    expect(await readiness(deps, project, template, plain, 'm')).toBe('')
    expect(await readiness(deps, project, template, relay, 'm')).toBe('browser relay: not registered')
    expect(checks).toEqual(['0', '1'])
  })
})
