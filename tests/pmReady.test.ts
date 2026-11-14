import { describe, expect, it } from 'vitest'
import { readyOf, readyRefusal, sameRepo } from '../shared/pm/ready'

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
