// Text left unsent in Claude's input box on herdr-core (WHR-286): read from real
// core screens of Claude Code 2.1.317 (fixtures/core-screens/: claude-draft-*.txt
// from terminal.read, *.ansi from the first paint of terminal.attach), shown after
// it stays put and the colored screen confirms it, then sent or cleared with the
// screen re-checked.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { coreDraft, queueSendNow, readDraft, type CoreDraftDeps } from '../server/utils/coreDraft'
import { createCoreScreens } from '../server/utils/coreScreen'
import { HerdrError } from '../server/utils/herdr'
import type { Pane } from '../shared/types'

const screen = (name: string) => readFileSync(new URL(`./fixtures/core-screens/${name}.txt`, import.meta.url), 'utf8')
const TYPED = screen('claude-draft-typed')
const INTERRUPTED = screen('claude-draft-interrupted')
const EMPTY = screen('claude-idle-empty-field')
const ansi = (name: string) => readFileSync(new URL(`./fixtures/core-screens/${name}.ansi`, import.meta.url), 'utf8')
// Claude's gray next-message suggestion "commit it", same screen read both ways.
const SUGGESTION = screen('claude-suggestion')
const SUGGESTION_COLORED = ansi('claude-suggestion')
const TYPED_COLORED = ansi('claude-draft-colored')
const RULE = '─'.repeat(60)
const field = (line: string) => ['● Done.', '', RULE, line, RULE, '  ? for shortcuts'].join('\n')

describe('readDraft', () => {
  it('reads text typed and left in the field', () => {
    expect(readDraft(TYPED, 'claude')).toEqual({ text: 'hello there', lines: 1 })
  })
  it('reads the multi-line prompt Claude put back after an interrupt', () => {
    expect(readDraft(INTERRUPTED, 'claude')).toEqual({
      text: 'Summarise the README in five bullets.\nKeep each bullet short.\nThen list open questions.', lines: 3,
    })
  })
  it('an empty field, the placeholder or sent messages are no draft', () => {
    expect(readDraft(EMPTY, 'claude')).toBeNull()
    expect(readDraft(screen('claude-idle'), 'claude')).toBeNull()
    expect(readDraft(field('❯ Try "how do I log an error?"'), 'claude')).toBeNull()
    // Sent messages keep a normal space after "❯".
    expect(readDraft(field('❯ hello there'), 'claude')).toBeNull()
  })
  it('the gray suggestion reads as text on the plain screen, as nothing on the colored one', () => {
    expect(readDraft(SUGGESTION, 'claude')).toEqual({ text: 'commit it', lines: 1 })
    expect(readDraft(SUGGESTION_COLORED, 'claude')).toBeNull()
    expect(readDraft(TYPED_COLORED, 'claude')).toEqual({ text: 'hi there', lines: 1 })
  })
  it('a pasted text left as its placeholder is shown as is', () => {
    expect(readDraft(field('❯ [Pasted text #1 +29 lines]'), 'claude')).toEqual({ text: '[Pasted text #1 +29 lines]', lines: 1 })
  })
  it('only for Claude', () => {
    expect(readDraft(TYPED, 'codex')).toBeNull()
  })
})

describe('queueSendNow', () => {
  it('Claude offers to send its queue now', () => {
    expect(queueSendNow(screen('claude-queued'), 'claude')).toBe(true)
    expect(queueSendNow(TYPED, 'claude')).toBe(false)
    expect(queueSendNow(screen('claude-queued'), 'codex')).toBe(false)
  })
})

const pane: Pane = { id: 'core:t2', workspace: 'w', tab: 'w:t', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: null, agentSession: null, coreAddress: 'local/t2' }

function fake(screens: string[], o: { turns?: number[], status?: string, colors?: string[] } = {}) {
  // By default the colored screen shows the same field as the plain one.
  const colored = o.colors ? [...o.colors] : null
  const keys: string[][] = []
  const turns = [...(o.turns || [3, 4])]
  let refreshed = 0
  const deps: CoreDraftDeps = {
    call: (async (method: string, params: { keys?: string[] }) => {
      if (method === 'terminal.keys') { keys.push(params.keys!); return {} }
      if (method === 'terminal.get') return { turn: turns.length > 1 ? turns.shift() : turns[0], status: o.status ?? 'idle' }
      throw new Error(method)
    }) as CoreDraftDeps['call'],
    pane: id => (id === pane.id ? pane : undefined),
    panes: () => [pane],
    refresh: () => { refreshed++ },
    read: async () => (colored ? screens[0]! : screens.length > 1 ? screens.shift()! : screens[0]!),
    colors: async () => (colored ? (colored.length > 1 ? colored.shift()! : colored[0]!) : screens.length > 1 ? screens.shift()! : screens[0]!),
    sleep: async () => {},
  }
  return { deps, keys, refreshed: () => refreshed }
}

const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof HerdrError ? e.code : String(e)))

describe('coreDraft', () => {
  it('Send now: Enter, then the field empties and a turn starts', async () => {
    const f = fake([TYPED, EMPTY])
    await expect(coreDraft(f.deps, { pane_id: pane.id, action: 'send', text: 'hello there' })).resolves.toEqual({ ok: true, started: true })
    expect(f.keys).toEqual([['enter']])
    expect(f.refreshed()).toBe(1)
  })
  it('Send now: field emptied but no turn seen is said so', async () => {
    const f = fake([TYPED, EMPTY], { turns: [3] })
    await expect(coreDraft(f.deps, { pane_id: pane.id, action: 'send', text: 'hello there' })).resolves.toEqual({ ok: true, started: false })
  })
  it('Send now: text still in the field is an error', async () => {
    const f = fake([TYPED])
    expect(await code(coreDraft(f.deps, { pane_id: pane.id, action: 'send', text: 'hello there' }))).toBe('not_submitted')
  })
  it('a field that changed since it was shown is refused, nothing pressed', async () => {
    const f = fake([TYPED])
    expect(await code(coreDraft(f.deps, { pane_id: pane.id, action: 'send', text: 'hello' }))).toBe('stale')
    const g = fake([EMPTY])
    expect(await code(coreDraft(g.deps, { pane_id: pane.id, action: 'clear', text: 'hello there' }))).toBe('stale')
    expect([...f.keys, ...g.keys]).toEqual([])
  })
  it('Clear: erases every line, then checks the field is empty', async () => {
    const f = fake([INTERRUPTED, EMPTY])
    await expect(coreDraft(f.deps, { pane_id: pane.id, action: 'clear', text: 'Summarise the README in five bullets. Keep each bullet short. Then list open questions.' })).resolves.toEqual({ ok: true })
    expect(f.keys).toHaveLength(1)
    expect(f.keys[0]!.filter(k => k === 'ctrl+u')).toHaveLength(5)
  })
  it('Claude’s gray suggestion is never sent nor cleared', async () => {
    for (const action of ['send', 'clear']) {
      const f = fake([SUGGESTION], { colors: [SUGGESTION_COLORED] })
      expect(await code(coreDraft(f.deps, { pane_id: pane.id, action, text: 'commit it' }))).toBe('stale')
      expect(f.keys).toEqual([])
    }
  })
  it('Clear: the suggestion that comes back after the text is erased counts as empty', async () => {
    const f = fake([TYPED], { colors: [TYPED_COLORED, SUGGESTION_COLORED] })
    await expect(coreDraft(f.deps, { pane_id: pane.id, action: 'clear', text: 'hi there' })).resolves.toEqual({ ok: true })
  })
  it('Send now: the suggestion that comes back after Enter counts as empty', async () => {
    const f = fake([EMPTY], { colors: [TYPED_COLORED, SUGGESTION_COLORED] })
    await expect(coreDraft(f.deps, { pane_id: pane.id, action: 'send', text: 'hi there' })).resolves.toEqual({ ok: true, started: true })
  })
  it('Clear: a field that stays full is an error', async () => {
    const f = fake([TYPED])
    expect(await code(coreDraft(f.deps, { pane_id: pane.id, action: 'clear', text: 'hello there' }))).toBe('clear_failed')
    expect(f.keys).toHaveLength(2)
  })
  it('Send now on Claude’s queue: ctrl+enter, only while Claude offers it', async () => {
    const f = fake([screen('claude-queued'), EMPTY])
    await expect(coreDraft(f.deps, { pane_id: pane.id, action: 'send-queued' })).resolves.toEqual({ ok: true })
    expect(f.keys).toEqual([['ctrl+enter']])
    const g = fake([TYPED])
    expect(await code(coreDraft(g.deps, { pane_id: pane.id, action: 'send-queued' }))).toBe('stale')
    const h = fake([screen('claude-queued')])
    expect(await code(coreDraft(h.deps, { pane_id: pane.id, action: 'send-queued' }))).toBe('not_submitted')
  })
  it('two quick Send now share one send; another action meanwhile is refused', async () => {
    const f = fake([screen('claude-queued'), EMPTY])
    const one = coreDraft(f.deps, { pane_id: pane.id, action: 'send-queued' })
    const two = coreDraft(f.deps, { pane_id: pane.id, action: 'send-queued' })
    expect(await code(coreDraft(f.deps, { pane_id: pane.id, action: 'clear', text: 'x' }))).toBe('busy')
    expect(two).toBe(one)
    await one
    expect(f.keys).toEqual([['ctrl+enter']])
  })
  it('bad action or pane', async () => {
    const f = fake([TYPED])
    expect(await code(coreDraft(f.deps, { pane_id: pane.id, action: 'run' }))).toBe('bad_action')
    expect(await code(coreDraft(f.deps, { pane_id: 'core:nope', action: 'send' }))).toBe('bad_pane')
  })
})

describe('enrich: draft on the pane', () => {
  function run(texts: { plain: () => string, colored: () => string }) {
    let t = 0
    let painted = 0
    const s = createCoreScreens({
      call: async () => ({ text: texts.plain() }), viewed: () => true, now: () => t,
      colors: async () => { painted++; return texts.colored() },
    })
    const at = async (ms: number, status: Pane['status'] = null) => { t = ms; const p: Pane = { ...pane, status }; await s.enrich([p]); return p }
    return { at, painted: () => painted, keyed: () => s.keyed(pane.id) }
  }
  it('shown once the same text stayed 2 s and the colored screen confirms it, gone once the field is empty', async () => {
    let plain = TYPED
    const r = run({ plain: () => plain, colored: () => TYPED })
    expect((await r.at(0)).draft).toBeUndefined()
    expect((await r.at(1000)).draft).toBeUndefined()
    expect((await r.at(2000)).draft).toEqual({ text: 'hello there', lines: 1 })
    expect((await r.at(3000)).draft).toEqual({ text: 'hello there', lines: 1 })
    expect(r.painted()).toBe(1)
    plain = EMPTY
    expect((await r.at(4000)).draft).toBeUndefined()
  })
  it('follows a key from the key bar at once, and Clear then matches Claude’s field', async () => {
    let plain = field('❯\u00a0abcdef')
    const r = run({ plain: () => plain, colored: () => plain })
    await r.at(0)
    expect((await r.at(2000)).draft?.text).toBe('abcdef')
    // Key bar: Delete, Home, Delete. The first poll may come before Claude redraws.
    r.keyed()
    expect((await r.at(2100)).draft?.text).toBe('abcdef')
    plain = field('❯\u00a0bcde')
    const shown = (await r.at(2500)).draft
    expect(shown?.text).toBe('bcde')
    const f = fake([plain, EMPTY])
    await expect(coreDraft(f.deps, { pane_id: pane.id, action: 'clear', text: shown!.text })).resolves.toEqual({ ok: true })
  })
  it('Claude’s gray suggestion is never shown as a draft (real screens)', async () => {
    const r = run({ plain: () => SUGGESTION, colored: () => SUGGESTION_COLORED })
    for (let t = 0; t <= 5000; t += 1000) expect((await r.at(t)).draft).toBeUndefined()
    expect(r.painted()).toBe(1)
  })
  it('no colored screen, no draft', async () => {
    const r = run({ plain: () => TYPED, colored: () => { throw new Error('x') } })
    for (let t = 0; t <= 3000; t += 1000) expect((await r.at(t)).draft).toBeUndefined()
  })
  it('a working Claude is not given a draft', async () => {
    const r = run({ plain: () => TYPED, colored: () => TYPED })
    for (let t = 0; t <= 3000; t += 1000) expect((await r.at(t, 'working')).draft).toBeUndefined()
  })
})
