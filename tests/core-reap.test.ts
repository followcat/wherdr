import { describe, expect, it } from 'vitest'
import { CoreError } from '../server/utils/core'
import { createCoreReaper, shouldReapExited } from '../server/utils/coreReap'

const done = (extra: object = {}) => ({ address: 't1', state: 'finished', reason: 'exited', exit_code: 0, created_ms: 1_000, ...extra })

describe('shouldReapExited', () => {
  it('reaps a terminal that simply exited: shells, agents, ad-hoc terminals', () => {
    expect(shouldReapExited(done())).toBe(true)
    expect(shouldReapExited(done({ labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' } }))).toBe(true)
    // A wherdr launch that exited cleanly leaves nothing to read: reaped at once.
    expect(shouldReapExited(done({ labels: { 'wherdr-request': 'ab12' } }), 1_001)).toBe(true)
  })
  it('never reaps a terminal still live or ended another way', () => {
    for (const t of [
      done({ state: 'live' }), done({ reason: 'killed' }), done({ reason: 'signaled' }),
      done({ reason: 'holder_lost' }), done({ reason: 'server_stop' }), done({ reason: 'host_shutdown' }),
      done({ reason: 'stopped_by_restart' }), done({ reason: null }), done({ reason: undefined }),
    ]) expect(shouldReapExited(t)).toBe(false)
  })
  it('keeps PM workers, reviewers and coordinators: a finished state is how the engine reads them', () => {
    for (const label of ['wherdr.run', 'wherdr.task', 'wherdr.coordinator'])
      expect(shouldReapExited(done({ labels: { 'wherdr.install': 'me', [label]: 'x' } }))).toBe(false)
  })
  it('leaves a fresh failed wherdr launch for launchFailure to read, then reaps it', () => {
    const t = done({ labels: { 'wherdr-request': 'ab12' }, exit_code: 127, created_ms: 1_000 })
    expect(shouldReapExited(t, 5_999)).toBe(false) // 4 999 ms in: still being read
    expect(shouldReapExited(t, 6_000)).toBe(true) // 5 s window past: reap
    // No timestamp to measure the window against: reaped at once.
    expect(shouldReapExited(done({ labels: { 'wherdr-request': 'ab12' }, exit_code: 127, created_ms: undefined }), 5)).toBe(true)
    // A clean exit never gets the window, however fresh.
    expect(shouldReapExited(done({ labels: { 'wherdr-request': 'ab12' }, exit_code: 0, created_ms: 5_999 }), 6_000)).toBe(true)
  })
})

describe('createCoreReaper', () => {
  const reaperWith = (impl: (m: string, p: { terminal: string }) => unknown = () => ({})) => {
    const calls: [string, string][] = []
    const reaper = createCoreReaper({ call: (async (m: string, p: { terminal: string }) => { calls.push([m, p.terminal]); return impl(m, p) }) as never })
    return { reaper, calls }
  }
  it('calls terminal.rm on each reaped address', async () => {
    const t = reaperWith()
    await t.reaper.maybeReap(done({ address: 't1' }))
    await t.reaper.maybeReap(done({ address: 'm/t2' }))
    await t.reaper.maybeReap(done({ address: 't3', reason: 'killed' }))
    expect(t.calls).toEqual([['terminal.rm', 't1'], ['terminal.rm', 'm/t2']])
  })
  it('deduplicates calls for an address while one is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const t = reaperWith(async () => { await gate })
    const first = t.reaper.maybeReap(done({ address: 't1' }))
    const second = t.reaper.maybeReap(done({ address: 't1' }))
    release()
    await Promise.all([first, second])
    expect(t.calls).toEqual([['terminal.rm', 't1']])
  })
  it('ignores a terminal core already forgot', async () => {
    const t = reaperWith(() => { throw new CoreError('not_found', 'gone') })
    await expect(t.reaper.maybeReap(done())).resolves.toBeUndefined()
  })
})
