// Sending to Claude Code next to another writer (the herdr-projects ticker
// typing "[hp inbox] …" with `herdr agent prompt`): played against a fake
// input field that behaves like the one observed on Claude Code 2.1.x
// (typed text appended, Ctrl+U clears, Enter submits the whole field, except
// after a "\\": that one becomes a line break and nothing is submitted).
import { describe, expect, it } from 'vitest'
import { type GuardDeps, classifyBox, guardedSend, submittable, withPaneLock } from '../server/utils/guardedSend'
import { HOLD_TTL_MS, QUEUED_TTL_MS, type QueueEntry, checkQueue, loadQueued, publicEntry } from '../server/utils/queued'

const OURS = 'do we have a way to pass the total number of threads (all projects) ?'
const NOTICE = '[hp inbox] t-0171 new report'

// Fake field. `on[n]` runs just before the n-th screen read (1-based):
// another writer acting while wherdr is in the middle of its send.
function field(o: { box?: string, on?: Record<number, (f: Fake) => void>, loseEnters?: number, show?: (t: string) => string } = {}) {
  const f = {
    box: o.box ?? '',
    reads: 0,
    clock: 0,
    submitted: [] as string[],
    typed: [] as string[],
    keys: [] as string[],
    loseEnters: o.loseEnters ?? 0,
    // Another writer: types its text, its own Enter comes later (`enter`).
    write(t: string) { f.box += t },
    enter() {
      // Claude Code: "\\" then Enter is a line break (2.1.296).
      if (f.box.endsWith('\\')) { f.box = `${f.box.slice(0, -1)}\n`; return }
      // The submitted message loses its trailing spaces (the only case
      // played here: the one typed after a final backslash).
      if (f.box) f.submitted.push(f.box.replace(/\\ $/, '\\'))
      f.box = ''
    },
  }
  const show = o.show || ((t: string) => t)
  const deps: GuardDeps = {
    box: async () => {
      f.reads++
      f.clock += 20
      o.on?.[f.reads]?.(f)
      return show(f.box)
    },
    type: async (t) => { f.typed.push(t); f.box += t },
    keys: async (keys) => {
      for (const k of keys) {
        f.keys.push(k)
        if (k === 'ctrl+u' || k === 'backspace') f.box = ''
        if (k === 'enter') {
          if (f.loseEnters > 0) { f.loseEnters--; continue }
          f.enter()
        }
      }
    },
    // Fake clock: each sleep and each screen read takes time.
    sleep: async (ms) => { f.clock += ms },
    now: () => f.clock,
    sentSince: async () => [...f.submitted],
  }
  return { f, deps }
}
type Fake = ReturnType<typeof field>['f']
const fast = { freeWaitMs: 500, quietMs: 0, showWaitMs: 500, submitWaitMs: 600, pollMs: 100 }

describe('guarded send to Claude Code', () => {
  it('an alternate terminator replaces Enter everywhere, its single retry included', async () => {
    const { f, deps } = field()
    const inner = deps.keys
    let lostTab = true
    deps.keys = async (ks) => {
      for (const k of ks) {
        if (k === 'tab') {
          f.keys.push(k)
          // First Tab lost (a lagging agent): the one retry presses it again.
          if (lostTab) { lostTab = false; continue }
          f.enter()
          continue
        }
        await inner([k])
      }
    }
    await guardedSend(deps, OURS, { ...fast, submitKey: 'tab' })
    expect(f.submitted).toEqual([OURS])
    expect(f.keys).toEqual(['tab', 'tab'])
    expect(f.keys).not.toContain('enter')
  })

  it('empty field: typed, checked, submitted once', async () => {
    const { f, deps } = field()
    expect(await guardedSend(deps, OURS, fast)).toEqual({ foreign: [], unsent: [] })
    expect(f.submitted).toEqual([OURS])
    expect(f.typed).toEqual([OURS])
    expect(f.keys.filter(k => k === 'ctrl+u')).toEqual([])
  })

  it('foreign text appended before Enter: cleared, ours retyped and sent alone, the foreign one typed back right after', async () => {
    // The real case: the ticker's notice lands right behind our text.
    const { f, deps } = field({ on: { 2: f => f.write(NOTICE) } })
    const r = await guardedSend(deps, OURS, fast)
    expect(f.submitted).toEqual([OURS, NOTICE])
    expect(r).toEqual({ foreign: [NOTICE], unsent: [] })
    expect(f.typed).toEqual([OURS, OURS, NOTICE])
  })

  it('foreign text appended, then its writer presses Enter on our retyped text: still two separate messages', async () => {
    const { f, deps } = field({ on: { 2: f => f.write(NOTICE), 8: f => f.enter() } })
    await guardedSend(deps, OURS, fast)
    expect(f.submitted).toEqual([OURS, NOTICE])
  })

  it('the other writer’s Enter submits the glued field before we can clear it: nothing typed again, no duplicate', async () => {
    // Seen on the real Claude: the notice and its Enter both land between
    // two of our reads. The damage is done; retyping would send copies.
    const { f, deps } = field({ on: { 2: (f) => { f.write(NOTICE) }, 3: f => f.enter() } })
    const lagging = { ...deps, box: async () => { const b = await deps.box(); return b } }
    // Our read #2 sees the glued field, the clear comes after the other Enter.
    const keys = deps.keys
    lagging.keys = async (k) => { if (k[0] === 'ctrl+u') f.enter(); await keys(k) }
    const r = await guardedSend(lagging, OURS, fast)
    expect(f.submitted).toEqual([OURS + NOTICE])
    expect(r).toEqual({ foreign: [], unsent: [] })
    expect(f.typed).toEqual([OURS])
  })

  it('the other writer’s Enter takes our text alone before our check: counted as sent', async () => {
    const { f, deps } = field({ on: { 1: () => {}, 2: f => f.enter() } })
    await guardedSend(deps, OURS, fast)
    expect(f.submitted).toEqual([OURS])
    expect(f.typed).toEqual([OURS])
  })

  it('foreign text typed just before ours (prepended): separated the same way', async () => {
    const { f, deps } = field({ on: { 2: f => { f.box = NOTICE + f.box } } })
    const r = await guardedSend(deps, OURS, fast)
    expect(f.submitted).toEqual([OURS, NOTICE])
    expect(r.foreign).toEqual([NOTICE])
  })

  it('field wraps our text over several lines: still recognized as ours', async () => {
    const wrap = (t: string) => t.replace(/(.{20}\S*) /g, '$1\n  ')
    const { f, deps } = field({ show: wrap, on: { 2: f => f.write(' ' + NOTICE) } })
    await guardedSend(deps, OURS, fast)
    expect(f.submitted).toEqual([OURS, NOTICE])
  })

  it('text already in the field before we start (a draft in the terminal): never cleared, the send is refused', async () => {
    const { f, deps } = field({ box: 'half-typed draft' })
    await expect(guardedSend(deps, OURS, fast)).rejects.toMatchObject({ code: 'input_busy' })
    expect(f.box).toBe('half-typed draft')
    expect(f.typed).toEqual([])
    expect(f.keys).toEqual([])
  })

  it('another writer submitting right before us: waits for the field to empty, then sends', async () => {
    const { f, deps } = field({ box: NOTICE, on: { 3: f => f.enter() } })
    await guardedSend(deps, OURS, fast)
    expect(f.submitted).toEqual([NOTICE, OURS])
  })

  it('another writer’s text appearing while the field looks free: we wait for it to go, then type', async () => {
    // Empty on the first read, the notice shows on the second (its
    // agent.prompt was already on its way), then its writer submits it.
    const { f, deps } = field({ on: { 2: f => f.write(NOTICE), 4: f => f.enter() } })
    await guardedSend(deps, OURS, { ...fast, quietMs: 250 })
    expect(f.submitted).toEqual([NOTICE, OURS])
    expect(f.typed).toEqual([OURS])
    expect(f.keys).not.toContain('ctrl+u')
  })

  it('Enter lost by Claude: pressed once more', async () => {
    const { f, deps } = field({ loseEnters: 1 })
    await guardedSend(deps, OURS, fast)
    expect(f.submitted).toEqual([OURS])
    expect(f.keys.filter(k => k === 'enter')).toHaveLength(2)
  })

  it('Enter not taken yet when the other writer types (lagging Claude): separated, both sent alone', async () => {
    const { f, deps } = field({ loseEnters: 1, on: { 3: f => f.write(NOTICE) } })
    const r = await guardedSend(deps, OURS, fast)
    expect(f.submitted).toEqual([OURS, NOTICE])
    expect(r.foreign).toEqual([NOTICE])
  })

  it('foreign text that cannot be read back (a paste stand-in): nothing cleared, sent as it is', async () => {
    const { f, deps } = field({ on: { 2: f => f.write(' [Pasted text #2 +40 lines]') } })
    await guardedSend(deps, OURS, fast)
    expect(f.submitted).toEqual([OURS + ' [Pasted text #2 +40 lines]'])
    expect(f.keys).not.toContain('ctrl+u')
  })

  it('our long text shown as "[Pasted text #1]": accepted as ours', async () => {
    const long = 'x '.repeat(600)
    const { f, deps } = field({ show: t => (t === long ? '[Pasted text #1]' : t) })
    await guardedSend(deps, long, fast)
    expect(f.submitted).toEqual([long])
  })

  it('foreign text that cannot be typed back now (field busy again): returned as unsent, never dropped', async () => {
    // After our message, someone starts a draft: the notice is kept for later.
    const { f, deps } = field({ on: { 2: f => f.write(NOTICE) } })
    let drafted = false
    const r = await guardedSend({ ...deps, box: async () => {
      if (f.submitted.length === 1 && !drafted) { drafted = true; f.box = 'new draft' }
      return deps.box()
    } }, OURS, fast)
    expect(f.submitted).toEqual([OURS])
    expect(r).toEqual({ foreign: [], unsent: [NOTICE] })
    expect(f.box).toBe('new draft')
  })

  it('field not on screen (menu open): refused, nothing typed', async () => {
    const deps = { ...field().deps, box: async () => null }
    await expect(guardedSend(deps, OURS, fast)).rejects.toMatchObject({ code: 'no_input' })
  })

  it('message never taken: reported (the caller shows it as not sent)', async () => {
    const { deps } = field({ loseEnters: 5 })
    await expect(guardedSend(deps, OURS, fast)).rejects.toMatchObject({ code: 'not_submitted' })
  })
})

describe('message ending with a backslash', () => {
  it('submitted once, with its backslash', async () => {
    const { f, deps } = field()
    expect(await guardedSend(deps, 'done\\', fast)).toEqual({ foreign: [], unsent: [] })
    expect(f.submitted).toEqual(['done\\'])
    expect(f.keys).toEqual(['enter'])
  })

  it('several backslashes, a Windows path, a regex: text intact', async () => {
    for (const text of ['a\\\\\\', 'C:\\Users\\me\\', '^\\d+\\', '\\']) {
      const { f, deps } = field()
      await guardedSend(deps, text, fast)
      expect(f.submitted).toEqual([text])
    }
  })

  it('last line of a multi-line message', async () => {
    const { f, deps } = field()
    await guardedSend(deps, 'first line\nsecond line\\', fast)
    expect(f.submitted).toEqual(['first line\nsecond line\\'])
  })

  it('a backslash inside the message, or a normal multi-line message: typed as it is', async () => {
    for (const text of ['a\\b', 'first line\nsecond line', 'path\\ ', OURS]) {
      const { f, deps } = field()
      await guardedSend(deps, text, fast)
      expect(f.typed).toEqual([text])
      expect(f.submitted).toEqual([text.trim()])
    }
  })

  it('foreign text glued to it: both still sent alone', async () => {
    const { f, deps } = field({ on: { 2: f => f.write(NOTICE) } })
    const r = await guardedSend(deps, 'done\\', fast)
    expect(f.submitted).toEqual(['done\\', NOTICE])
    expect(r).toEqual({ foreign: [NOTICE], unsent: [] })
  })

  it('what is typed for it', () => {
    expect(submittable('done\\')).toBe('done\\ ')
    expect(submittable('done\\\\')).toBe('done\\\\ ')
    expect(submittable('done')).toBe('done')
    expect(submittable('do\\ne')).toBe('do\\ne')
    expect(submittable('')).toBe('')
  })

  it('Enter that leaves a part of our text in the field: reported as not sent, never as taken', async () => {
    // What Claude Code did with "done\\" before the trailing space: the field
    // kept "done" and an empty line, and the message was counted as sent.
    const { f, deps } = field()
    const keys = deps.keys
    const eaten = { ...deps, keys: async (k: string[]) => { if (k[0] === 'enter') f.box = 'do\n'; else await keys(k) } }
    await expect(guardedSend(eaten, 'done', fast)).rejects.toMatchObject({ code: 'not_submitted' })
    expect(f.submitted).toEqual([])
  })
})

describe('reading the field against our text', () => {
  it('kinds', () => {
    expect(classifyBox('', OURS)).toEqual({ kind: 'empty' })
    expect(classifyBox(OURS, OURS)).toEqual({ kind: 'exact' })
    expect(classifyBox(OURS.slice(0, 10), OURS)).toEqual({ kind: 'partial' })
    expect(classifyBox(OURS + NOTICE, OURS)).toEqual({ kind: 'glued', foreign: [NOTICE] })
    expect(classifyBox(`${NOTICE}\n  ${OURS}`, OURS)).toEqual({ kind: 'glued', foreign: [NOTICE] })
    expect(classifyBox('something else', OURS)).toEqual({ kind: 'unknown' })
    expect(classifyBox('[Pasted text #3] ' + NOTICE, 'y'.repeat(900))).toEqual({ kind: 'glued', foreign: [NOTICE] })
  })
})

describe('per-pane lock', () => {
  it('runs wherdr’s sends to one pane one after the other, other panes in parallel', async () => {
    const order: string[] = []
    const step = (name: string, ms: number) => () => new Promise<void>(r => setTimeout(() => { order.push(name); r() }, ms))
    await Promise.all([
      withPaneLock('w1:p1', step('a1', 30)),
      withPaneLock('w1:p1', step('a2', 1)),
      withPaneLock('w1:p2', step('b1', 10)),
    ])
    expect(order).toEqual(['b1', 'a1', 'a2'])
  })
  it('a failed send does not block the next one', async () => {
    await expect(withPaneLock('w1:p3', async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(await withPaneLock('w1:p3', async () => 1)).toBe(1)
  })
})

describe('message held while the field is busy', () => {
  const q = (o: Partial<QueueEntry> = {}): QueueEntry => ({ id: 'a', text: 't', at: 0, held: true, busy: true, ...o })
  it('keeps the draft and actions available beyond the former busy timeout', () => {
    const list = [q({ inputText: 'ns' })]
    for (const now of [60_000, 121_000, HOLD_TTL_MS + 1, QUEUED_TTL_MS + 1]) {
      expect(checkQueue(list, 'idle', now)).toBe(false)
      expect(publicEntry(list[0]!)).toMatchObject({ state: 'held', reason: 'busy', inputText: 'ns' })
    }
    expect(publicEntry(q({ busy: false }))).not.toHaveProperty('reason')
  })
  it('does not fail on the first idle poll after a long turn reveals a draft', () => {
    const entry = q({ busy: false, turn: true })
    const now = 5 * 60_000
    expect(checkQueue([entry], 'working', now)).toBe(false)
    expect(checkQueue([entry], 'idle', now)).toBe(false)
    // deliverHeld discovers the terminal draft after that idle check.
    entry.busy = true
    entry.inputText = 'ns'
    expect(checkQueue([entry], 'idle', now + 1000)).toBe(false)
    expect(publicEntry(entry)).toMatchObject({ state: 'held', reason: 'busy', inputText: 'ns' })
  })
  it('kept across a restart, including an older busy hold', () => {
    for (const now of [20, QUEUED_TTL_MS + 20]) {
      const entry = loadQueued({ 'w1:p1': [q({ at: 10 })] }, now)[0]![1][0]!
      expect(entry).toMatchObject({ busy: true, held: true })
      expect(entry.failed).toBeUndefined()
    }
  })
})
