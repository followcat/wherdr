import { describe, expect, it, vi } from 'vitest'
// The send notes itself in DATA_DIR/submitting.json: a folder of this test's own.
vi.hoisted(async () => { const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/wherdr-core-input-`) })
import { CoreError } from '../server/utils/core'
import { coreInput, coreInterrupt, failure, coreKeepGet, coreKeepSet, coreKill, coreSend, holdEnter, resumeSubmitting, type CoreInputDeps } from '../server/utils/coreInput'
import { fieldHolds, isBareBang } from '../shared/queuedMatch'
import { takingTurns } from '../server/utils/terminalTurns'
import { noteSubmitting, onSubmittingChange, sendingText, sendingTo } from '../server/utils/submitting'
import { HerdrError } from '../server/utils/herdr'
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
    turnSettleMs: 0,
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

  it('sends to Command Code once and never adds a Claude Enter workaround', async () => {
    const t = deps((m) => m === 'terminal.send' ? { started: true } : {})
    const cmdPane = t.d.pane('t1') as Pane
    cmdPane.agent = 'cmd'
    cmdPane.coreAddress = 'host-a/proj/term-1'
    expect(await coreSend(t.d, { pane_id: 't1', text: 'fix the bug' })).toEqual({ ok: true, started: true })
    expect(t.calls).toEqual([['terminal.send', { terminal: 'host-a/proj/term-1', text: 'fix the bug' }, 30000]])

    // started=false on a multi-line send: Command Code keeps its own submit; no
    // status read, no extra Enter, no retry.
    const w = deps((m) => m === 'terminal.send' ? { started: false } : {})
    w.d.settleMs = 1
    ;(w.d.pane('t1') as Pane).agent = 'cmd'
    expect(await coreSend(w.d, { pane_id: 't1', text: 'see\n@/f/a.txt' })).toEqual({ ok: true, started: false })
    await coreSend(w.d, { pane_id: 't1', text: 'one line' })
    expect(w.calls.map(c => [c[0], c[1].terminal])).toEqual([
      ['terminal.send', 'm/t1'], ['terminal.send', 'm/t1'],
    ])

    // A pane reported working still goes through one send, nothing else.
    const g = deps((m) => m === 'terminal.send' ? { started: true } : {})
    const working = g.d.pane('t1') as Pane
    working.agent = 'cmd'
    working.status = 'working'
    await coreSend(g.d, { pane_id: 't1', text: 'keep\nworking' })
    expect(g.calls.map(c => c[0])).toEqual(['terminal.send'])

    // Other agents get no workaround either: one send, whatever core observed.
    const o = deps((m) => m === 'terminal.send' ? { started: false } : {})
    o.d.settleMs = 1
    ;(o.d.pane('t1') as Pane).agent = 'codex'
    expect(await coreSend(o.d, { pane_id: 't1', text: 'a\nb' })).toEqual({ ok: true, started: false })
    expect(o.calls.map(c => c[0])).toEqual(['terminal.send'])
  })

  it('fails a Command Code send like any other: blocked and timeout mutate once', async () => {
    for (const [kind, code] of [['blocked', 'blocked'], ['timeout', 'timeout']]) {
      const t = deps(() => new CoreError(kind!, 'x'))
      ;(t.d.pane('t1') as Pane).agent = 'cmd'
      await expect(coreSend(t.d, { pane_id: 't1', text: 'hi\nthere' })).rejects.toMatchObject({ code })
      expect(t.calls).toHaveLength(1)
      expect(t.calls[0]![0]).toBe('terminal.send')
    }
  })

  it('Claude\'s input already holds text: nothing typed, the send is refused', async () => {
    const t = deps(() => ({ started: true }))
    t.d.field = async () => '[Image #120] what is wrong here?'
    await expect(coreSend(t.d, { pane_id: 't1', text: 'and this?' })).rejects.toMatchObject({ code: 'input_busy' })
    expect(t.calls).toEqual([])
  })

  it('Claude\'s input cannot be read (still pasting, core lost): looked at again, never typed over', async () => {
    const t = deps(() => ({ started: true }))
    t.d.settleMs = 1
    t.d.field = async () => { throw new HerdrError('pasting', 'Claude is still pasting') }
    await expect(coreSend(t.d, { pane_id: 't1', text: 'hi' })).rejects.toMatchObject({ code: 'input_busy' })
    t.d.field = async () => { throw new CoreError('disconnected', 'closed') }
    await expect(coreSend(t.d, { pane_id: 't1', text: 'hi' })).rejects.toMatchObject({ code: 'unreachable', unconfirmed: true })
    expect(t.calls).toEqual([])
  })

  it('stuck behind another writer: refused at its deadline, nothing typed, even once that writer ends', async () => {
    let release!: () => void
    const wake = new Promise<void>(r => { release = r })
    const t = deps(() => ({ started: true }))
    t.d.startByMs = 20
    const engine = takingTurns(async (m, params) => { t.calls.push([m, params, 0]); await wake; return {} as never }, 0)
    void engine('terminal.send', { terminal: 'm/t1', text: 'Autopilot wake' }, 30000)
    await expect(coreSend(t.d, { pane_id: 't1', text: 'hi' })).rejects.toMatchObject({ code: 'busy' })
    release()
    await new Promise(r => setTimeout(r, 10))
    expect(t.calls.map(c => c[1].text)).toEqual(['Autopilot wake'])
  })

  it('a message of its own ending with "\\" matches the field that holds it', () => {
    expect(fieldHolds('C:\\dir\\', 'C:\\dir\\', true)).toBe(true)
    expect(fieldHolds('C:\\dir', 'C:\\dir\\', true)).toBe(false)
  })

  it('a send while a wake is being typed waits for it, then goes once the field is empty', async () => {
    let release!: () => void
    const wake = new Promise<void>(r => { release = r })
    const t = deps(() => ({ started: true }))
    t.d.settleMs = 1
    const engine = takingTurns(async (m, params) => { t.calls.push([m, params, 0]); await wake; return {} as never }, 0)
    const delivering = engine('terminal.send', { terminal: 'm/t1', text: 'Autopilot wake' }, 30000)
    // Claude still empties its field for a moment after the wake.
    let looks = 0
    t.d.field = async () => (looks++ < 2 ? 'Autopilot wake' : null)
    const sending = coreSend(t.d, { pane_id: 't1', text: 'look\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png' })
    await new Promise(r => setTimeout(r, 5))
    expect(t.calls.map(c => c[1].text)).toEqual(['Autopilot wake'])
    release()
    await delivering
    expect(await sending).toEqual({ ok: true, started: true })
    expect(t.calls.map(c => c[1].text)).toEqual(['Autopilot wake', 'look\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png\n\\'])
  })

  it('a send right after a wake was delivered: typed once the field is empty, once, nothing left in it', async () => {
    const t = deps(() => ({ started: true }))
    t.d.settleMs = 1
    const engine = takingTurns(async () => ({}) as never, 40)
    await engine('terminal.send', { terminal: 'm/t9', text: 'Autopilot wake' }, 30000)
    ;(t.d.pane('t1') as Pane).coreAddress = 'm/t9'
    const done = Date.now()
    let field: string | null = 'Autopilot wake'
    t.d.field = async () => field
    setTimeout(() => { field = null }, 20)
    const photos = '/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png\n/srv/core/files/t1/2026-01-01T10-00-01-000Z-d4e5f6.png\nwhat now?'
    const sending = coreSend(t.d, { pane_id: 't1', text: photos })
    await sending
    expect(Date.now() - done).toBeGreaterThanOrEqual(35)
    expect(t.calls).toEqual([['terminal.send', { terminal: 'm/t9', text: `${photos}\n\\` }, 30000]])
    expect(await t.d.field!(t.d.pane('t1')!)).toBeNull()
  })

  it('our photo message left in Claude\'s input (also during a turn): Enter once; not for other text', async () => {
    const msg = '/home/user/.cache/herdr-web/uploads/a.jpg\nwhat is wrong here?'
    const long = `${msg}\n${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}`
    for (const [text, after, enters] of [[msg, '[Image #120] what is wrong here?', 1], [msg, '', 0], [msg, '[Image #120] what is wrong here? more', 0],
      // A long paste, shown as its stand-in: still ours alone.
      [long, '[Image #120] what is wrong here? [Pasted text #1 +29 lines]', 1], [long.split('\n').slice(1).join('\n'), '[Pasted text #1 +30 lines]', 1]] as const) {
      let reads = 0
      let entered = false
      const t = deps((m) => { if (m === 'terminal.keys') entered = true; return m === 'terminal.send' ? { started: false } : {} })
      t.d.settleMs = 1
      t.d.field = async () => (reads++ && !entered ? after : null)
      // Other text there when the wait ends: no Enter, refused for the conversation's "Not sent" (WHR-472).
      const sent = coreSend(t.d, { pane_id: 't1', text })
      if (after.endsWith('more')) await expect(sent).rejects.toMatchObject({ code: 'not_submitted' })
      else await sent
      expect(t.calls.filter(c => c[0] === 'terminal.keys')).toHaveLength(enters)
    }
  })

  it('text + photo: sent with a lone "\\" (core\'s Enter is a new line), submitted once Claude shows the tag, drawn first', async () => {
    const msg = 'look\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png'
    expect(holdEnter('no photo')).toBe('no photo')
    // Claude reads the photo (its path still there), then draws "[Image #4]" before
    // the text; the "\" stays while no Enter came after it.
    const screens = [null, `${msg}\n\\`, '[Image #4]look\n\\']
    let looks = 0
    let enters = 0
    const t = deps((m) => { if (m === 'terminal.keys') enters++; return m === 'terminal.send' ? { started: false } : {} })
    t.d.settleMs = 1
    t.d.field = async () => (enters ? null : screens[Math.min(looks++, 2)]!)
    expect(await coreSend(t.d, { pane_id: 't1', text: msg })).toEqual({ ok: true, started: null })
    expect(t.calls[0]![1].text).toBe(`${msg}\n\\`)
    expect(enters).toBe(1)
    expect(fieldHolds('[Image #4] look', msg, true)).toBe(true)
  })

  // Claude Code 2.1.319 reads a pasted photo path within 1 s, or keeps it as typed text for good.
  it('a photo Claude leaves as its path: cleared and pasted once more; still a path, the "\\" is taken out and Enter pressed', async () => {
    const msg = 'look at this\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png'
    const run = async (second: string) => {
      const keys: string[] = []
      let field: string | null = null
      let sends = 0
      const t = deps((m, params) => {
        if (m === 'terminal.send') { sends++; field = sends === 1 ? `${msg}\n\\` : second }
        if (m === 'terminal.keys') {
          keys.push(...params.keys)
          if (params.keys[0] === 'ctrl+u') field = null
          if (params.keys[0] === 'backspace' && params.keys.length === 1) field = field!.replace(/\n?\\$/, '')
          if (params.keys[0] === 'enter') field = null
        }
        return m === 'terminal.send' ? { started: false } : {}
      })
      t.d.settleMs = 1
      let looks = 0
      t.d.field = async () => (looks++ ? field : null)
      const logs: string[] = []
      const warn = console.warn
      console.warn = (l: string) => { logs.push(l) }
      try {
        expect(await coreSend(t.d, { pane_id: 't1', text: msg })).toEqual({ ok: true, started: null })
      } finally { console.warn = warn }
      return { keys, sends, logs, cleared: keys.includes('ctrl+u') }
    }
    // The second paste becomes an image: Enter on it.
    const warm = await run('[Image #2]look at this\n\\')
    expect(warm.sends).toBe(2)
    expect(warm.cleared).toBe(true)
    expect(warm.keys.at(-1)).toBe('enter')
    expect(warm.logs).toEqual([expect.stringMatching(/a photo stayed a path after \d+ ms, pasted again$/)])
    // A path again: sent as it is, its "\\" taken out; one more log line, sizes only.
    const cold = await run(`${msg}\n\\`)
    expect(cold.sends).toBe(2)
    expect(cold.keys.slice(-2)).toEqual(['backspace', 'enter'])
    expect(cold.logs).toHaveLength(2)
    expect(cold.logs[1]).toMatch(/a photo stayed a path, sent as it is after \d+ ms: field held \d+ chars, 0 images; expected \d+ chars, 1 images, 2 lines$/)
    expect(cold.logs.join('\n')).not.toMatch(/look|srv/)
  })

  // A core photo path (~90 chars) wider than Claude's field: drawn over two lines (WHR-546).
  const wrapped = (msg: string) => {
    const keys: string[] = []
    const sent: string[] = []
    let field: string | null = null
    const t = deps((m, params) => {
      if (m === 'terminal.send') {
        sent.push(params.text)
        const [text, path, ...rest] = params.text.split('\n')
        field = path ? [text, path.slice(0, 40), path.slice(40), ...rest].join('\n') : params.text
      }
      if (m === 'terminal.keys') {
        keys.push(...params.keys)
        if (params.keys[0] === 'ctrl+u') field = null
        if (params.keys[0] === 'backspace' && params.keys.length === 1) field = field!.replace(/\n?\\$/, '')
        if (params.keys[0] === 'enter') { sent.push(`enter on ${field}`); field = null }
      }
      return m === 'terminal.send' ? { started: false } : {}
    })
    t.d.settleMs = 1
    t.d.field = async () => field
    return { t, keys, sent }
  }
  const longMsg = 'look at this\n/home/user/.local/share/herdr-core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png'

  it('a photo path Claude draws over two lines, kept through the wait: submitted once as a path, its "\\" taken out first', async () => {
    const { t, keys, sent } = wrapped(longMsg)
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(await coreSend(t.d, { pane_id: 't1', text: longMsg })).toEqual({ ok: true, started: null })
    } finally { console.warn = warn }
    expect(keys.filter(k => k === 'enter')).toHaveLength(1)
    expect(keys.slice(-2)).toEqual(['backspace', 'enter'])
    expect(sent.at(-1)).toMatch(/^enter on [^\\]*$/)
  })

  it('a message sent while the one before is still being submitted: sent after it, in order', async () => {
    const { t, sent } = wrapped(longMsg)
    const warn = console.warn
    console.warn = () => {}
    try {
      const first = coreSend(t.d, { pane_id: 't1', text: longMsg })
      await new Promise(r => setTimeout(r, 5))
      const second = coreSend(t.d, { pane_id: 't1', text: 'and then?' })
      expect(await first).toEqual({ ok: true, started: null })
      expect(await second).toEqual({ ok: true, started: null })
    } finally { console.warn = warn }
    expect(sent.filter(s => !s.startsWith('enter'))).toEqual([`${longMsg}\n\\`, `${longMsg}\n\\`, 'and then?'])
  })

  it('a slow core (each read, send and key near its timeout): the photo fallback stops in time, answered under 120 s', async () => {
    const msg = 'look at this\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png'
    let clock = 1_000_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    let field: string | null = null
    const t = deps((m, params) => {
      if (m === 'terminal.send') { clock += 29_000; field = `${msg}\n\\` }
      if (m === 'terminal.keys') {
        clock += 9_000
        if (params.keys[0] === 'backspace') field = `${msg}\n\\`
      }
      return m === 'terminal.send' ? { started: false } : {}
    })
    t.d.settleMs = 1
    let looks = 0
    t.d.field = async () => { clock += 15_000; return looks++ ? field : null }
    const warn = console.warn
    console.warn = () => {}
    const start = clock
    try {
      await coreSend(t.d, { pane_id: 't1', text: msg }).catch(() => null)
    } finally { console.warn = warn; now.mockRestore() }
    expect(clock - start).toBeLessThan(120_000)
  })

  it('a photo path cleared to be pasted again: never sent in part, nor lost when the field cannot be read', async () => {
    const msg = 'important instructions\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png'
    // `cleared`: the field after each clear (a clear that leaves part of the text, or a field no longer readable).
    const run = async (cleared: () => string | null | Error) => {
      const keys: string[] = []
      let field: string | null | Error = null
      let sends = 0
      const t = deps((m, params) => {
        if (m === 'terminal.send') { sends++; field = `${msg}\n\\` }
        if (m === 'terminal.keys') { keys.push(...params.keys); if (params.keys[0] === 'ctrl+u') field = cleared() }
        return m === 'terminal.send' ? { started: false } : {}
      })
      t.d.settleMs = 1
      let looks = 0
      t.d.field = async () => { if (!looks++) return null; if (field instanceof Error) throw field; return field }
      const warn = console.warn
      console.warn = () => {}
      try {
        await expect(coreSend(t.d, { pane_id: 't1', text: msg })).rejects.toMatchObject({ code: 'not_submitted' })
      } finally { console.warn = warn }
      // Never Enter on what is left, never pasted again into it: the conversation offers Retry with the whole message.
      expect(keys).not.toContain('enter')
      expect(sends).toBe(1)
      return keys.filter(k => k === 'ctrl+u').length
    }
    // Each clear leaves "important": cleared again (bounded), then refused.
    expect(await run(() => 'important')).toBeGreaterThan(1)
    // Cleared, but the field is no longer readable: refused too.
    expect(await run(() => new Error('paint'))).toBeGreaterThan(0)
  })

  // WHR-472, on Claude Code 2.1.319: a multi-line message is collapsed into
  // "[Pasted text #N +K lines]"; a photo Claude missed is inside it as its
  // path, so no "[Image #N]" shows for it. Pasted again, it shows.
  it('a photo inside a collapsed paste: pasted again, then sent as it is; the wait is capped; each start and end is pushed', async () => {
    const msg = 'Three things to check:\nthe header\nthe menu\nthe list\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png'
    const run = async (second: string) => {
      const keys: string[] = []
      let field: string | null = null
      let sends = 0
      const t = deps((m, params) => {
        if (m === 'terminal.send') { sends++; field = sends === 1 ? '[Pasted text #12 +4 lines]' : second }
        if (m === 'terminal.keys') { keys.push(...params.keys); if (['ctrl+u', 'enter'].includes(params.keys[0])) field = null }
        return m === 'terminal.send' ? { started: false } : {}
      })
      t.d.settleMs = 1
      t.d.submitting = noteSubmitting
      const pushed: (string | undefined)[] = []
      onSubmittingChange(() => pushed.push(sendingText('m/t1')))
      let looks = 0
      t.d.field = async () => (looks++ ? field : null)
      const warn = console.warn
      console.warn = () => {}
      try {
        expect(await coreSend(t.d, { pane_id: 't1', text: msg })).toEqual({ ok: true, started: null })
      } finally { console.warn = warn; onSubmittingChange(() => {}) }
      // The open pages hear of the send and of its end at once, the user's text with it.
      expect(pushed).toEqual([msg, undefined])
      return { keys, sends }
    }
    const warm = await run('[Image #13][Pasted text #14 +4 lines]')
    expect(warm.sends).toBe(2)
    expect(warm.keys).toContain('ctrl+u')
    expect(warm.keys.at(-1)).toBe('enter')
    // Still no tag: Enter, the photo goes as its path (no "\" to take out of a stand-in).
    const cold = await run('[Pasted text #14 +4 lines]')
    expect(cold.sends).toBe(2)
    expect(cold.keys.slice(-1)).toEqual(['enter'])
    expect(cold.keys.filter(k => k === 'backspace')).toHaveLength(cold.keys.filter(k => k === 'ctrl+u').length)
    // A field that never holds the message alone, read slowly: refused once the wait ends, not after its 60 looks.
    const t = deps(m => (m === 'terminal.send' ? { started: false } : {}))
    t.d.settleMs = 1
    t.d.photoWaitMs = 100
    let looks = 0
    t.d.field = async () => { await new Promise(r => setTimeout(r, 40)); return looks++ ? 'Three things to check:' : null }
    const warn = console.warn
    console.warn = () => {}
    const at = Date.now()
    try {
      await expect(coreSend(t.d, { pane_id: 't1', text: msg })).rejects.toMatchObject({ code: 'not_submitted' })
    } finally { console.warn = warn }
    expect(Date.now() - at).toBeLessThan(1000)
    expect(t.calls.some(c => c[0] === 'terminal.keys')).toBe(false)
  })

  // WHR-549, on Claude Code 2.1.319: two photos Claude missed stay in the paste
  // as paths, which makes a one-line text long enough to be collapsed, its "\"
  // inside "[Pasted text #N +3 lines]" where no Backspace reaches it.
  it('a long text + photos collapsed with its "\\" inside: pasted again without it, submitted once', async () => {
    const msg = 'Look at these two screenshots of the settings page\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png\n/srv/core/files/t1/2026-01-01T10-00-01-000Z-d4e5f6.png'
    // A text that is long without its photos: no "\", it would be inside the stand-in.
    const long = `one\ntwo\nthree\n${msg}`
    expect(holdEnter(long)).toBe(long)
    for (const second of [null, '[Pasted text #4 +2 lines]']) {
      let field: string | null = null
      const sent: string[] = []
      const keys: string[] = []
      const t = deps((m, params) => {
        if (m === 'terminal.send') { sent.push(params.text); field = sent.length === 1 ? '[Pasted text #3 +3 lines]' : second }
        if (m === 'terminal.keys') { keys.push(...params.keys); if (['ctrl+u', 'enter'].includes(params.keys[0])) field = null }
        return m === 'terminal.send' ? { started: false } : {}
      })
      t.d.settleMs = 1
      let looks = 0
      t.d.field = async () => (looks++ ? field : null)
      const warn = console.warn
      console.warn = () => {}
      try {
        expect((await coreSend(t.d, { pane_id: 't1', text: msg })).ok).toBe(true)
      } finally { console.warn = warn }
      expect(sent).toEqual([`${msg}\n\\`, msg])
      // Taken with core's Enter, or Enter once on the stand-in: never a "\" left in what Claude gets.
      expect(keys.filter(k => k === 'enter')).toHaveLength(second ? 1 : 0)
    }
  })

  it('after a restart, a stand-in hiding the "\\": pasted again without it, never Enter on it', async () => {
    const msg = 'Look at these\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png\n/srv/core/files/t1/2026-01-01T10-00-01-000Z-d4e5f6.png'
    let field: string | null = '[Pasted text #3 +3 lines]'
    const keys: string[] = []
    const sent: string[] = []
    const t = deps((m, params) => {
      if (m === 'terminal.send') { sent.push(params.text); field = null }
      if (m === 'terminal.keys') { keys.push(...params.keys); if (params.keys[0] === 'ctrl+u') field = null }
      return {}
    })
    t.d.settleMs = 1
    t.d.field = async () => field
    const warn = console.warn
    console.warn = () => {}
    try {
      await resumeSubmitting(t.d, [{ id: 'c', terminal: 'm/t1', text: msg, at: Date.now() }])
    } finally { console.warn = warn }
    expect(sent).toEqual([msg])
    expect(keys).not.toContain('enter')
  })

  it('a long text alone that Claude collapses, with or without "+K lines": Enter once', async () => {
    for (const [text, collapsed] of [['x'.repeat(900), '[Pasted text #5]'], ['a\nb\nc\nd\ne', '[Pasted text #5 +4 lines]']]) {
      let enters = 0
      let looks = 0
      const t = deps((m) => { if (m === 'terminal.keys') enters++; return m === 'terminal.send' ? { started: false } : {} })
      t.d.settleMs = 1
      t.d.field = async () => (looks++ && !enters ? collapsed : null)
      expect(await coreSend(t.d, { pane_id: 't1', text })).toEqual({ ok: true, started: null })
      expect(t.calls[0]![1].text).toBe(text)
      expect(enters).toBe(1)
    }
    // Another paste's line count is not this message.
    expect(fieldHolds('[Pasted text #5 +9 lines]', 'a\nb\nc\nd\ne', true)).toBe(false)
  })

  it('slow field reads: too little of the wait left to paste again, the message goes as it is, Enter within the wait from the paste', async () => {
    const msg = 'Three things to check:\nthe header\nthe menu\nthe list\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png'
    const keys: string[] = []
    let enterAt = 0
    let field: string | null = null
    const t = deps((m, params) => {
      if (m === 'terminal.send') field = '[Pasted text #12 +4 lines]'
      if (m === 'terminal.keys') { keys.push(...params.keys); if (params.keys[0] === 'enter') { enterAt ||= Date.now(); field = null } }
      return m === 'terminal.send' ? { started: false } : {}
    })
    t.d.settleMs = 1
    t.d.photoWaitMs = 600
    let looks = 0
    // Each read takes 120 ms: the fourth look at the missing photo comes with about a sixth of the wait left.
    t.d.field = async () => { if (!looks++) return null; await new Promise(r => setTimeout(r, 120)); return field }
    const warn = console.warn
    console.warn = () => {}
    const at = Date.now()
    try {
      expect(await coreSend(t.d, { pane_id: 't1', text: msg })).toEqual({ ok: true, started: null })
    } finally { console.warn = warn }
    expect(keys).not.toContain('ctrl+u')
    expect(t.calls.filter(c => c[0] === 'terminal.send')).toHaveLength(1)
    expect(enterAt - at).toBeLessThan(600 + 200)
  })

  it('no client after the first request: the send still runs to its Enter, its terminal shown as sending until then', async () => {
    const msg = 'look at this\n/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png'
    let enters = 0
    let sendingAtEnter = false
    const t = deps((m) => { if (m === 'terminal.keys') { enters++; sendingAtEnter = sendingTo('m/t1') } return m === 'terminal.send' ? { started: false } : {} })
    t.d.settleMs = 1
    t.d.submitting = noteSubmitting
    let looks = 0
    t.d.field = async () => (looks++ === 0 ? null : enters ? null : looks < 5 ? `${msg}\n\\` : '[Image #2]look at this\n\\')
    // The page sends, then leaves: nobody awaits or reads the answer.
    const run = coreSend(t.d, { pane_id: 't1', text: msg })
    await run
    expect(enters).toBe(1)
    expect(sendingAtEnter).toBe(true)
    expect(sendingTo('m/t1')).toBe(false)
  })

  it('a photo message: Enter only once Claude shows its placeholder, again while it stays (bounded)', async () => {
    const msg = '/home/user/.cache/herdr-web/uploads/a.jpg\nwhat is wrong here?'
    const path = '/home/user/.cache/herdr-web/uploads/a.jpg what is wrong here?'
    const tag = '[Image #3] what is wrong here?'
    // Claude still reading the photo: its path is in the field, then "[Image #3]";
    // the first two Enters are dropped (Claude switching turns), the third takes it.
    const run = async (send: object, screen: (look: number, enters: number) => string | null) => {
      const seen: (string | null)[] = []
      let looks = 0
      let enters = 0
      let last: string | null = null
      const t = deps((m) => { if (m === 'terminal.keys') { seen.push(last); enters++ } return m === 'terminal.send' ? send : {} })
      t.d.settleMs = 1
      t.d.field = async () => (last = screen(looks++, enters))
      return { r: await coreSend(t.d, { pane_id: 't1', text: msg }), seen, looks: () => looks }
    }
    const dropped = await run({ started: false }, (n, e) => (n === 0 ? null : n < 3 ? path : e < 3 ? tag : null))
    expect(dropped.r).toEqual({ ok: true, started: null })
    expect(dropped.seen).toEqual([tag, tag, tag])
    // Never taken: at most ten Enters, then the field's own "Not sent".
    expect((await run({ started: false }, n => (n ? tag : null))).seen).toHaveLength(10)
    // A large photo whose placeholder shows after about 20 s (50 looks, the field empty meanwhile): still submitted, once.
    expect((await run({ started: false }, (n, e) => { if (n > 0 && n < 50) throw new HerdrError('pasting', 'Claude is still pasting'); return n && !e ? tag : null })).seen).toEqual([tag])
  })

  it('sent while Claude works: core says started, yet its Enter came before the placeholder; it is submitted once', async () => {
    const msg = '/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png\nsecond picture, describe it'
    let looks = 0
    let enters = 0
    // herdr-core 0.1.16 answers `started: true, status: "working"` for a send during a turn.
    const t = deps((m) => { if (m === 'terminal.keys') enters++; return m === 'terminal.send' ? { started: true, status: 'working' } : {} })
    t.d.settleMs = 1
    t.d.field = async () => (looks++ === 0 ? null : looks < 4 ? msg.replace('\n', ' ') : enters ? null : '[Image #2]second picture, describe it')
    expect(await coreSend(t.d, { pane_id: 't1', text: msg })).toEqual({ ok: true, started: null })
    expect(enters).toBe(1)
    // Taken at once from an idle agent: one look at the empty field, no Enter.
    const idle = deps(m => (m === 'terminal.send' ? { started: true, status: 'idle' } : {}))
    idle.d.settleMs = 1
    let read = 0
    idle.d.field = async () => { read++; return null }
    expect(await coreSend(idle.d, { pane_id: 't1', text: msg })).toEqual({ ok: true, started: true })
    expect(read).toBe(2)
    expect(idle.calls.map(c => c[0])).toEqual(['terminal.send'])
  })

  it('idle agent: core says started, yet the message stays in the input and Enter is ignored twice; it is submitted once', async () => {
    const msg = '/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.jpg\nwhat is on this screenshot?'
    let looks = 0
    let enters = 0
    const t = deps((m) => { if (m === 'terminal.keys') enters++; return m === 'terminal.send' ? { started: true, status: 'idle' } : {} })
    t.d.settleMs = 1
    // A failed read in between is not an empty field.
    t.d.field = async () => { looks++; if (looks === 2) throw new Error('paint'); return looks === 1 || enters >= 3 ? null : '[Image #8] what is on this screenshot?' }
    expect(await coreSend(t.d, { pane_id: 't1', text: msg })).toEqual({ ok: true, started: null })
    expect(enters).toBe(3)
  })

  // WHR-419, reproduced on Claude Code 2.1.319: three large photos and a
  // multi-line text to an idle Claude. Its field stays empty under "Pasting…"
  // for seconds (the photos are read), then shows them renumbered with the
  // text collapsed; the send's own Enter is lost.
  const three = ['/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c1.jpg', '/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c2.jpg', '/srv/core/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.jpg',
    'Three screenshots of the settings page.', '', 'The header overlaps the menu.', 'The list loses its scroll.', '', 'Thanks!'].join('\n')
  const collapsed = '[Image #9] [Image #10] [Image #11][Pasted text #12 +6 lines]'

  it('three photos and a multi-line text: an empty field under "Pasting…" is not taken; submitted once it shows', async () => {
    let looks = 0
    let enters = 0
    const noted: string[] = []
    let notedAtSend = 0
    const t = deps((m) => { if (m === 'terminal.keys') enters++; if (m === 'terminal.send') notedAtSend = noted.length; return m === 'terminal.send' ? { started: false, status: 'idle' } : {} })
    t.d.settleMs = 1
    t.d.submitting = (_terminal, text) => { noted.push(text); return () => { noted.splice(noted.indexOf(text), 1) } }
    t.d.field = async () => {
      looks++
      if (looks === 1 || enters) return null
      if (looks < 20) throw new HerdrError('pasting', 'Claude is still pasting')
      return collapsed
    }
    expect(await coreSend(t.d, { pane_id: 't1', text: three })).toEqual({ ok: true, started: null })
    expect(notedAtSend).toBe(1)
    expect(enters).toBe(1)
    expect(noted).toEqual([])
  })

  it('a restart mid-send: resumed, Enter only while the field holds that message; a log line with sizes, never text', async () => {
    let enters = 0
    const t = deps((m) => { if (m === 'terminal.keys') enters++; return {} })
    t.d.settleMs = 1
    t.d.field = async () => (enters ? null : collapsed)
    await resumeSubmitting(t.d, [{ id: 'a', terminal: 'm/t1', text: three, at: Date.now() }])
    expect(enters).toBe(1)
    // Already taken before the restart: nothing pressed. Other text there: nothing pressed, and why is logged.
    const logs: string[] = []
    const warn = console.warn
    console.warn = (l: string) => { logs.push(l) }
    try {
      for (const now of [null, '[Image #9] something else']) {
        const o = deps()
        o.d.settleMs = 1
        o.d.field = async () => now
        await resumeSubmitting(o.d, [{ id: 'b', terminal: 'm/t1', text: three, at: Date.now() }])
        expect(o.calls.filter(c => c[0] === 'terminal.keys')).toEqual([])
      }
    } finally { console.warn = warn }
    expect(logs.at(-1)).toMatch(/never held the message alone: field held 20 chars, 1 images; expected 109 chars, 3 images, 9 lines$/)
    expect(logs.join('\n')).not.toMatch(/settings|something/)
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

  it('forwards canonical modifier chords and refuses names outside the key grammar', async () => {
    const t = deps()
    // `ctrl+plus` is deliberately absent: the grammar accepts it, but herdr-core
    // resolves no `plus` alias — grammar acceptance proves nothing about core
    // encoding, so the client blocks it before the wire.
    for (const k of ['ctrl+alt+shift+left', 'ctrl+alt+up', 'shift+left', 'ctrl+backslash', 'alt+shift+a']) await coreInput(t.d, { pane_id: 't1', keys: [k] })
    expect(t.calls.map(c => (c[1] as { keys: string[] }).keys[0])).toEqual(['ctrl+alt+shift+left', 'ctrl+alt+up', 'shift+left', 'ctrl+backslash', 'alt+shift+a'])
    // The chord names of control bytes 29–31 (Ctrl+], Ctrl+^, Ctrl+_) cannot
    // be represented: the client keeps such a byte as text, and the API
    // refuses the name if one ever arrives.
    for (const bad of ['ctrl+]', 'ctrl+^', 'ctrl+_', ']', 'ctrl+ left']) {
      await expect(coreInput(t.d, { pane_id: 't1', keys: [bad] })).rejects.toMatchObject({ code: 'bad_keys' })
    }
  })

  it('reports what interrupt observed without escalating', async () => {
    for (const [outcome, stopped] of [['stopped', true], ['exited', true], ['still_working', false], ['unknown', false]] as const) {
      const t = deps(() => ({ outcome, key: 'esc' }))
      expect(await coreInterrupt(t.d, { pane_id: 't1' })).toMatchObject({ ok: true, outcome, stopped })
      expect(t.calls.map(c => c[0])).toEqual(['terminal.interrupt'])
    }
  })

  it('kills one terminal, or each terminal of its group, leaving no finished entry', async () => {
    const t = deps()
    await coreKill(t.d, { pane_id: 't1' })
    await coreKill(t.d, { pane_id: 't1', close_group: true })
    expect(t.calls.map(c => [c[0], c[1].terminal])).toEqual([
      ['terminal.kill', 'm/t1'], ['terminal.rm', 'm/t1'],
      ['terminal.kill', 'm/t1'], ['terminal.rm', 'm/t1'],
      ['terminal.kill', 'm/t2'], ['terminal.rm', 'm/t2'],
    ])
    // Already gone from core's side (the pane closed itself meanwhile): fine.
    const gone = deps(m => m === 'terminal.rm' ? new CoreError('not_found', 'gone') : {})
    await expect(coreKill(gone.d, { pane_id: 't1' })).resolves.toEqual({ ok: true })
    // The kill itself failing still reports; no rm is attempted.
    const dead = deps(() => new CoreError('not_found', 'gone'))
    await expect(coreKill(dead.d, { pane_id: 't1' })).rejects.toMatchObject({ code: 'stale' })
    expect(dead.calls.map(c => c[0])).toEqual(['terminal.kill'])
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

describe('failure (WHR-570)', () => {
  const said = (e: unknown) => { try { failure(e) } catch (x) { return x as HerdrError } throw new Error('no throw') }
  it('keeps the kind, message and hint of a refusal it has no sentence for', () => {
    const e = said(new CoreError('brand_new', 'the disk is full', 'free some space'))
    expect([e.code, e.message]).toEqual(['brand_new', 'herdr-core refused (brand_new): the disk is full (free some space)'])
  })
  it('never gives an empty reason, nor the kind twice', () => {
    expect(said(new CoreError('brand_new', '')).message).toBe('herdr-core refused (brand_new): it gave no reason')
    expect(said(new CoreError('config', 'config')).message).toBe('herdr-core refused (config): its configuration has a problem')
    expect(said(new Error('')).message).not.toBe('')
  })
})
