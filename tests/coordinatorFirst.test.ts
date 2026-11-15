import { describe, expect, it, vi } from 'vitest'
import { deliverFirst, resendFirst, startTurn, type FirstDeps } from '../server/utils/coordinatorFirst'
import type { CoordinatorRecord } from '../server/utils/pmStore'

// Terminals that become idle at a given time (ms after the start), or end; `flaky`: the
// first terminal.get of each fails (a timeout).
function fake(readyAt: Record<string, number>, ended: string[] = [], flaky = false) {
  const t0 = Date.now(), sent: [string, string][] = [], log: [string, string][] = [], asked = new Set<string>()
  const recs = new Map<string, CoordinatorRecord>()
  const deps = {
    pollMs: 1, readyWatchMs: 20, queueWatchMs: 2000,
    call: (async (m: string, p: { terminal: string, text?: string }) => {
      if (m === 'terminal.get' && flaky && !asked.has(p.terminal)) { asked.add(p.terminal); throw new Error('timeout') }
      if (m === 'terminal.get') return ended.includes(p.terminal) ? { state: 'finished' } : { state: 'live', status: Date.now() - t0 >= readyAt[p.terminal]! ? 'idle' : 'working' }
      if (m === 'terminal.read') return { text: 'ready' }
      if (m === 'terminal.send') sent.push([p.terminal, p.text!])
      return {}
    }) as never,
    store: {
      coordinator: async (k: string) => recs.get(k) ?? null,
      saveCoordinator: async (c: CoordinatorRecord) => { recs.set(c.project, c) },
      logProject: async (k: string, e: { text: string }) => { log.push([k, e.text]) },
    },
  } as unknown as FirstDeps
  for (const k of Object.keys(readyAt).concat(ended)) recs.set(k, { project: k, tokenHash: '', terminal: k })
  return { deps, sent, log, recs }
}

describe('first messages of coordinators', () => {
  it('three started at once each get theirs, in order; a slow one once ready, past readyWatchMs', async () => {
    const { deps, sent, log } = fake({ A: 0, B: 30, C: 150 })
    const r = await Promise.all(['A', 'B', 'C'].map(k => deliverFirst(deps, k, k, [`${k} prompt`, `${k} propose`])))
    expect(r).toEqual(['sent', 'sent', 'sent'])
    for (const k of ['A', 'B', 'C']) expect(sent.filter(s => s[0] === k).map(s => s[1])).toEqual([`${k} prompt`, `${k} propose`])
    expect(log).toContainEqual(['C', 'first message queued (not ready yet): typed once it is ready'])
    expect(log).toContainEqual(['C', 'first message sent (2 messages)'])
    expect(log.filter(l => l[0] === 'A')).toEqual([['A', 'first message sent (2 messages)']])
  })

  it('a failure is logged and kept on its record; Send again delivers it', async () => {
    const f = fake({}, ['D'])
    expect(await deliverFirst(f.deps, 'D', 'D', ['hello'])).toBe('failed')
    expect(f.log).toEqual([['D', 'first message not delivered: its session ended before it was ready']])
    expect(f.recs.get('D')!.undelivered).toMatchObject({ texts: ['hello'], why: 'its session ended before it was ready' })
    // Its session ended: Send again starts a new conversation (startCoordinator replays the record's messages).
    const g = fake({ D2: 0 }, ['D'])
    g.recs.set('D', f.recs.get('D')!)
    const restarted = vi.fn(async () => {})
    expect(await resendFirst(g.deps, 'D', restarted)).toEqual({ restarted: true, queued: 1 })
    expect(restarted).toHaveBeenCalledOnce()
    // Its session runs: typed again once it is ready.
    g.recs.get('D')!.terminal = 'D2'
    expect(await resendFirst(g.deps, 'D', restarted)).toEqual({ queued: 1 })
    await expect.poll(() => g.sent).toEqual([['D2', 'hello']])
    await expect.poll(() => g.recs.get('D')!.undelivered).toBeUndefined()
    await expect(resendFirst(g.deps, 'D', restarted)).rejects.toThrow('No first message')
  })

  it('a fresh start with its messages on its command line: watched until up, a failed status query retried', async () => {
    const f = fake({ E: 30 }, ['F'], true)
    let up = 0
    expect(await deliverFirst(f.deps, 'E', 'E', ['propose'], () => up++, true)).toBe('sent')
    expect(up).toBeGreaterThan(0)
    expect(f.sent).toEqual([])
    expect(f.log).toEqual([['E', 'first message queued (its machine does not answer): given at its start, watched until its session is up'], ['E', 'first message given at its start, its session is up']])
    expect(await deliverFirst(f.deps, 'F', 'F', ['propose'], () => {}, true)).toBe('failed')
    expect(f.recs.get('F')!.undelivered).toMatchObject({ texts: ['propose'], why: 'its session ended before it was ready' })
  })

  it('starts go one after another: each once the one before is up, at most startGapMs', async () => {
    const order: string[] = []
    const first = await startTurn({ startGapMs: 5000 })
    const second = startTurn({ startGapMs: 5000 }).then((up) => { order.push('second'); return up })
    await new Promise(r => setTimeout(r, 20))
    order.push('first up')
    first()
    ;(await second)()
    expect(order).toEqual(['first up', 'second'])
    // One never up: the next goes after the gap.
    await startTurn({ startGapMs: 5000 })
    const t = Date.now()
    ;(await startTurn({ startGapMs: 30 }))()
    expect(Date.now() - t).toBeGreaterThanOrEqual(25)
  })
})
