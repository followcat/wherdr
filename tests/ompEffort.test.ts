// omp thinking level from wherdr: ⇧⇥ presses on a fake Herdr socket, each
// one moving omp to the next level of its cycle and writing a
// "thinking_level_change" entry (the configured level) to its transcript.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const GLYPH: Record<string, string> = { off: '⦸', auto: '⟳', low: '◔', medium: '◑', high: '◒', xhigh: '◕', max: '◉' }
const fake = vi.hoisted(() => ({
  sent: [] as string[][],
  cycle: ['off', 'auto', 'low', 'medium', 'high'], // a model without xhigh / max
  level: 'medium',
  resolved: null as string | null, // "auto" after a turn: the glyph of the level it chose
  tick: 0,
  frozen: false, // omp ignores the key (subagent view, no thinking)
  noTranscript: false, // session file not found: only the status line
  freezeAfter: Infinity, // omp stops reacting after that many presses
}))
// Far ahead: the transcript is always newer than wherdr's own record of a change.
const at = () => `2099-01-01T00:00:${String(fake.tick).padStart(2, '0')}.000Z`
const status = () => {
  const shown = fake.level === 'auto' && fake.resolved ? fake.resolved : fake.level
  return ` ok\n π > ${GLYPH[shown]} Opus 5.5 > 🗑 ~/demo > ▶─1%──────\n╰─        ⇧⇥ to change thinking effort`
}

vi.mock('../server/utils/env', async (importOriginal) => ({ ...(await importOriginal()), log: () => {} }))
vi.mock('../server/utils/actions', () => ({ closePanel: async () => false }))
vi.mock('../server/utils/machines', () => ({ machineOfPane: () => null }))
vi.mock('../server/utils/state', () => ({
  READY: new Set(['idle', 'done']),
  findPane: () => ({ id: 'w1:p1', agent: 'omp', status: 'idle' }),
  poll: () => {},
  transcripts: { model: async () => (fake.noTranscript ? null : { id: 'anthropic/claude-opus-5-5', label: 'Opus 5.5', effort: fake.level, at: at() }) },
}))
vi.mock('../server/utils/herdr', () => ({
  HerdrError: class HerdrError extends Error {
    constructor(public code: string, message: string) { super(message) }
  },
  sleep: async () => {},
  agentPrompt: async () => {},
  herdr: async (method: string, params: Record<string, unknown>) => {
    if (method === 'pane.read') return { read: { text: status() } }
    if (method === 'pane.send_input') {
      const keys = params.keys as string[]
      fake.sent.push(keys)
      if (keys[0] === 'shift+tab' && !fake.frozen && fake.sent.length <= fake.freezeAfter) {
        fake.level = fake.cycle[(fake.cycle.indexOf(fake.level) + 1) % fake.cycle.length]!
        fake.tick++
      }
    }
    return {}
  },
}))

import { currentModel, forgetModel, listEfforts, noteScreen, setEffort } from '../server/utils/modelctl'

const pane = { id: 'w1:p1', agent: 'omp', status: 'idle' } as Parameters<typeof currentModel>[0]

describe('omp thinking level (⇧⇥ cycle)', () => {
  beforeEach(() => {
    forgetModel('w1:p1')
    Object.assign(fake, {
      sent: [], cycle: ['off', 'auto', 'low', 'medium', 'high'], level: 'medium', resolved: null, tick: 0,
      frozen: false, noTranscript: false, freezeAfter: Infinity,
    })
  })

  it('presses ⇧⇥ until the level is reached, and nothing else', async () => {
    expect((await listEfforts('w1:p1')).current).toBe('medium')
    const r = await setEffort('w1:p1', 'auto')
    expect(fake.sent).toEqual([['shift+tab'], ['shift+tab'], ['shift+tab']])
    expect(fake.level).toBe('auto')
    expect(r).toMatchObject({ label: 'Opus 5.5', effort: 'auto' })
  })

  it('follows the transcript when "auto" already shows the next level\'s glyph', async () => {
    Object.assign(fake, { level: 'auto', resolved: 'low' })
    await setEffort('w1:p1', 'low')
    expect(fake.sent).toEqual([['shift+tab']])
    expect(fake.level).toBe('low')
  })

  it('a level the model lacks: one full turn back to the start, then the list drops it', async () => {
    await expect(setEffort('w1:p1', 'max')).rejects.toMatchObject({ code: 'bad_effort' })
    expect(fake.level).toBe('medium')
    expect(fake.sent).toHaveLength(fake.cycle.length)
    expect((await listEfforts('w1:p1')).levels).toEqual(['off', 'auto', 'low', 'medium', 'high'])
  })

  it('stops at once when omp does not react', async () => {
    fake.frozen = true
    await expect(setEffort('w1:p1', 'high')).rejects.toMatchObject({ code: 'stale' })
    expect(fake.sent).toEqual([['shift+tab']])
  })

  // Real omp 18.4 session (Opus 5.5): low → medium → high → xhigh → max → off
  // → auto, one transcript entry per press.
  it('stops on each level of the real cycle', async () => {
    fake.cycle = ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']
    for (const [from, to, presses] of [['low', 'medium', 1], ['medium', 'max', 3], ['max', 'off', 1], ['off', 'auto', 1], ['high', 'low', 5]] as const) {
      Object.assign(fake, { sent: [], level: from })
      await expect(setEffort('w1:p1', to)).resolves.toMatchObject({ effort: to })
      expect(fake.level).toBe(to)
      expect(fake.sent).toHaveLength(presses)
    }
  })

  it('without a transcript, finds "auto" although its glyph shows the level it resolved to', async () => {
    fake.cycle = ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']
    Object.assign(fake, { level: 'auto', resolved: 'low' })
    await setEffort('w1:p1', 'low')
    // The session file goes missing: wherdr only has its record and the status line.
    Object.assign(fake, { sent: [], noTranscript: true })
    await expect(setEffort('w1:p1', 'auto')).resolves.toMatchObject({ effort: 'auto' })
    expect(fake.level).toBe('auto')
    expect(fake.sent).toHaveLength(6)
    // From a resolved "auto", the next press keeps the glyph and still counts.
    Object.assign(fake, { sent: [] })
    await expect(setEffort('w1:p1', 'medium')).resolves.toMatchObject({ effort: 'medium' })
    expect(fake.level).toBe('medium')
    expect(fake.sent).toHaveLength(2)
  })

  it('a cycle that stops on the way leaves the field on the level omp reached', async () => {
    fake.cycle = ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']
    Object.assign(fake, { level: 'max' })
    await setEffort('w1:p1', 'low')
    Object.assign(fake, { sent: [], noTranscript: true, freezeAfter: 1 })
    await expect(setEffort('w1:p1', 'high')).rejects.toMatchObject({ code: 'stale' })
    expect(fake.level).toBe('medium')
    expect((await listEfforts('w1:p1')).current).toBe('medium')
  })

  it('a new conversation without a transcript: model and level from the status line, and changeable', async () => {
    fake.cycle = ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']
    Object.assign(fake, { level: 'auto', noTranscript: true })
    noteScreen('w1:p1', 'omp', status())
    expect(await currentModel(pane)).toMatchObject({ label: 'Opus 5.5', effort: 'auto' })
    expect((await listEfforts('w1:p1')).current).toBe('auto')
    await expect(setEffort('w1:p1', 'high')).resolves.toMatchObject({ label: 'Opus 5.5', effort: 'high' })
    expect(fake.level).toBe('high')
    expect(fake.sent).toHaveLength(3)
  })

  it('"auto" after a turn: the configured level, with the one it resolved to', async () => {
    Object.assign(fake, { level: 'auto', resolved: 'low' })
    noteScreen('w1:p1', 'omp', status())
    expect(await currentModel(pane)).toMatchObject({ effort: 'auto', effortResolved: 'low' })
  })
})
