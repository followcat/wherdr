import { describe, expect, it } from 'vitest'
import { CoreError } from '../server/utils/core'
import { coreInput, coreInterrupt, coreKeepGet, coreKeepSet, coreKill, coreSend, type CoreInputDeps } from '../server/utils/coreInput'
import { isBareBang } from '../shared/queuedMatch'
import type { Pane } from '../shared/types'

const pane = (id: string, extra: Partial<Pane> = {}) => ({ id, workspace: 'w1', coreAddress: `m/${id}`, agent: 'claude', ...extra }) as Pane
function deps(reply: (method: string, params: any) => unknown = () => ({})) {
  const calls: [string, any, number][] = []
  let refreshed = 0
  const panes = [pane('t1'), pane('t2'), pane('t3', { workspace: 'w2' })]
  const d: CoreInputDeps = {
    call: async (method, params, timeout) => {
      calls.push([method, params, timeout])
      const r = reply(method, params)
      if (r instanceof Error) throw r
      return r as never
    },
    pane: id => panes.find(p => p.id === id),
    panes: () => panes,
    refresh: () => { refreshed++ },
  }
  return { d, calls, refreshed: () => refreshed }
}

describe('core input routes', () => {
  it('sends a message once with terminal.send on the full address', async () => {
    const t = deps(() => ({ started: true, turn: 3 }))
    expect(await coreSend(t.d, { pane_id: 't1', text: 'fix the bug' })).toEqual({ ok: true, started: true })
    expect(t.calls).toEqual([['terminal.send', { terminal: 'm/t1', text: 'fix the bug' }, 30000]])
    expect(t.refreshed()).toBe(1)
    await expect(coreSend(t.d, { pane_id: 't1', text: '  ' })).rejects.toMatchObject({ code: 'empty' })
    await expect(coreSend(t.d, { pane_id: 'nope', text: 'x' })).rejects.toMatchObject({ code: 'bad_pane' })
  })

  it('presses Enter once when a multi-line send was left in the input (no turn started)', async () => {
    const t = deps((m) => m === 'terminal.send' ? { started: false } : m === 'terminal.get' ? { status: 'idle' } : {})
    t.d.settleMs = 1
    expect(await coreSend(t.d, { pane_id: 't1', text: 'see\n@/f/a.txt' })).toEqual({ ok: true, started: null })
    expect(t.calls.map(c => c[0])).toEqual(['terminal.send', 'terminal.get', 'terminal.keys'])
    expect(t.calls[2]![1]).toEqual({ terminal: 'm/t1', keys: ['enter'] })
    // Already working, or a one-line message: no extra Enter.
    const w = deps((m) => m === 'terminal.send' ? { started: false } : { status: { state: 'blocked' } })
    w.d.settleMs = 1
    await coreSend(w.d, { pane_id: 't1', text: 'a\nb' })
    await coreSend(w.d, { pane_id: 't1', text: 'one line' })
    expect(w.calls.filter(c => c[0] === 'terminal.keys')).toHaveLength(0)
  })

  it('sends a multi-line "!" command as it is, in one terminal.send', async () => {
    // Claude Code 2.1.318 runs the whole text in bash mode, lines included.
    const cmd = '! cd /srv/app\nnpm run build\n. ./env.sh dev\nls dist/'
    const t = deps(() => ({ started: true }))
    expect(await coreSend(t.d, { pane_id: 't1', text: cmd })).toEqual({ ok: true, started: true })
    expect(t.calls).toEqual([['terminal.send', { terminal: 'm/t1', text: cmd }, 30000]])
  })

  it('refuses a lone "!": it would leave Claude in bash mode for the next message', async () => {
    for (const text of ['!', ' ! ', '!\n']) {
      const t = deps()
      await expect(coreSend(t.d, { pane_id: 't1', text })).rejects.toMatchObject({ code: 'empty' })
      expect(t.calls).toHaveLength(0)
    }
    expect(isBareBang('! ls')).toBe(false)
    expect(isBareBang('!!')).toBe(false)
  })

  it('maps core errors to stable messages and never retries', async () => {
    for (const [kind, code] of [['blocked', 'blocked'], ['timeout', 'timeout'], ['not_found', 'stale'], ['unavailable', 'unreachable'], ['unreachable', 'unreachable']]) {
      const t = deps(() => new CoreError(kind!, 'x'))
      await expect(coreSend(t.d, { pane_id: 't1', text: 'hi' })).rejects.toMatchObject({ code })
      expect(t.calls).toHaveLength(1)
    }
  })

  it('routes text + Enter as a message and named keys through terminal.keys', async () => {
    const t = deps()
    await coreInput(t.d, { pane_id: 't1', text: 'ls', keys: ['enter'] })
    await coreInput(t.d, { pane_id: 't1', keys: ['esc', 'shift+tab'] })
    expect(t.calls.map(c => [c[0], c[1]])).toEqual([
      ['terminal.send', { terminal: 'm/t1', text: 'ls' }],
      ['terminal.keys', { terminal: 'm/t1', keys: ['esc', 'shift+tab'] }],
    ])
    await expect(coreInput(t.d, { pane_id: 't1', text: 'raw' })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(coreInput(t.d, { pane_id: 't1', keys: ['esc;x'] })).rejects.toMatchObject({ code: 'bad_keys' })
  })

  it('passes the key bar navigation keys to core by name', async () => {
    const t = deps()
    for (const k of ['home', 'end', 'pageup', 'pagedown', 'insert', 'delete', 'ctrl+shift+end']) await coreInput(t.d, { pane_id: 't1', keys: [k] })
    expect(t.calls.map(c => (c[1] as { keys: string[] }).keys[0])).toEqual(['home', 'end', 'pageup', 'pagedown', 'insert', 'delete', 'ctrl+shift+end'])
  })

  it('reports what interrupt observed without escalating', async () => {
    for (const [outcome, stopped] of [['stopped', true], ['exited', true], ['still_working', false], ['unknown', false]] as const) {
      const t = deps(() => ({ outcome, key: 'esc' }))
      expect(await coreInterrupt(t.d, { pane_id: 't1' })).toMatchObject({ ok: true, outcome, stopped })
      expect(t.calls.map(c => c[0])).toEqual(['terminal.interrupt'])
    }
  })

  it('kills one terminal, or each terminal of its group', async () => {
    const t = deps()
    await coreKill(t.d, { pane_id: 't1' })
    await coreKill(t.d, { pane_id: 't1', close_group: true })
    expect(t.calls.map(c => c[1].terminal)).toEqual(['m/t1', 'm/t1', 'm/t2'])
  })
})

describe('keep after restart', () => {
  it('reads the flag with terminal.get and sets it with terminal.keep on the full address', async () => {
    const t = deps(m => m === 'terminal.get' ? { keep: true } : {})
    expect(await coreKeepGet(t.d, 't1')).toEqual({ keep: true })
    expect(await coreKeepSet(t.d, { pane_id: 't1', keep: false })).toEqual({ keep: false })
    expect(t.calls.map(c => [c[0], c[1]])).toEqual([['terminal.get', { terminal: 'm/t1' }], ['terminal.keep', { terminal: 'm/t1', keep: false }]])
  })
  it('refuses a missing pane and a non-boolean value', async () => {
    const t = deps()
    await expect(coreKeepSet(t.d, { pane_id: 'nope', keep: true })).rejects.toMatchObject({ code: 'bad_pane' })
    await expect(coreKeepSet(t.d, { pane_id: 't1', keep: 'yes' })).rejects.toMatchObject({ code: 'bad_keep' })
  })
})

describe('core interrupt: prompt put back by Claude', () => {
  it('returns the text taken back after a Stop from the conversation', async () => {
    const t = deps(() => ({ outcome: 'stopped' }))
    const taken: string[] = []
    t.d.takeBack = async (p) => { taken.push(p.id); return { text: 'queued message', lost: 0 } }
    expect(await coreInterrupt(t.d, { pane_id: 't1', restore: true })).toMatchObject({ stopped: true, restored: 'queued message' })
    expect(taken).toEqual(['t1'])
  })
  it('does not take anything back without restore, when not stopped, or for another agent', async () => {
    const t = deps(() => ({ outcome: 'timeout' }))
    let n = 0
    t.d.takeBack = async () => { n++; return { text: 'x', lost: 0 } }
    expect(await coreInterrupt(t.d, { pane_id: 't1', restore: true })).not.toHaveProperty('restored')
    const u = deps(() => ({ outcome: 'stopped' }))
    u.d.takeBack = async () => { n++; return { text: 'x', lost: 0 } }
    await coreInterrupt(u.d, { pane_id: 't1' })
    ;(u.d.pane('t2') as Pane).agent = 'codex'
    await coreInterrupt(u.d, { pane_id: 't2', restore: true })
    expect(n).toBe(0)
  })
})
