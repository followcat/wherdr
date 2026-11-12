import { describe, expect, it } from 'vitest'
import { createModelCtl, type ModelCtlDeps } from '../server/utils/modelctl'
import type { ModelInfo, ModelList, Pane } from '../shared/types'

const pane = (agent: string | null, machine = '') => ({ id: 'w1:p1', agent, machine } as Pane)
const iso = (ms: number) => new Date(ms).toISOString()
const ctl = (over: Partial<ModelCtlDeps> = {}, transcript: ModelInfo | null = null, config: string | null = null) => createModelCtl({
  transcript: async () => transcript,
  codexConfig: async () => config,
  machineKey: p => p.machine || '',
  now: () => 1000,
  ...over,
})

const DEVIN_STATUS = `
❭ Ask Devin to build features, fix bugs, or work on your code
─────────────────────────────────────────────────────────────────────────
SWE-2 Max · bypass                                                See usage and cost: /session-stats
`
const OMP_STATUS = ' π > ◑ Opus 5.5 > 🗑 ~/demo > ▶─1%────'

describe('currentModel merge', () => {
  it('opencode and cmd read the transcript directly', async () => {
    const info = { id: 'm1', label: 'Model 1' }
    const c = ctl({ transcript: async () => info })
    expect(await c.currentModel(pane('opencode'))).toBe(info)
    expect(await c.currentModel(pane('cmd'))).toBe(info)
  })
  it('returns null for agents without a transcript', async () => {
    const c = ctl()
    expect(await c.currentModel(pane(null))).toBeNull()
    expect(await c.currentModel(pane('shell'))).toBeNull()
  })
  it('codex: the status line wins over a lagging transcript', async () => {
    const c = ctl({}, { id: 'gpt-5', label: 'GPT-5', at: iso(500) })
    c.noteScreen('w1:p1', 'codex', '› prompt\n\n  GPT-6-Sol medium · ~/demo')
    expect(await c.currentModel(pane('codex'))).toMatchObject({ label: 'GPT-6-Sol', effort: 'medium', at: iso(1000) })
  })
  it('codex: keeps the transcript id when the footer names the same model', async () => {
    const c = ctl({}, { id: 'gpt-6-sol', label: 'GPT-6-Sol', effort: 'medium', at: '2026-01-01T00:00:00.000Z' })
    c.noteScreen('w1:p1', 'codex', '› prompt\n\n  GPT-6-Sol medium · ~/demo')
    expect(await c.currentModel(pane('codex'))).toMatchObject({ id: 'gpt-6-sol', label: 'GPT-6-Sol' })
  })
  it('codex: config.toml fallback when nothing was seen', async () => {
    const c = ctl({}, null, 'model = "gpt-5.6-terra"\nmodel_reasoning_effort = "high"\n')
    expect(await c.currentModel(pane('codex'))).toMatchObject({ id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', effort: 'high' })
  })
  it('claude: the screen effort merges over the transcript default', async () => {
    const c = ctl({}, { id: 'opus-5-5', label: 'Opus 5.5', effort: 'medium' })
    c.noteScreen('w1:p1', 'claude', ' Opus 5.5 with low effort · Claude Pro')
    expect(await c.currentModel(pane('claude'))).toMatchObject({ label: 'Opus 5.5', effort: 'low' })
  })
  it('claude: header model when there is no transcript yet', async () => {
    const c = ctl()
    c.noteScreen('w1:p1', 'claude', ' ▐▛███▜▌   Claude Code\n▝▜█████▛▘  Sonnet 5 · Claude Max\n────────\n❯ \n────────')
    expect(await c.currentModel(pane('claude'))).toMatchObject({ label: 'Sonnet 5', effort: null })
  })
  it('claude: falls back on the cached list\'s "Default (recommended)" hint', async () => {
    const c = ctl()
    const list: ModelList = { agent: 'claude', at: 1, options: [{ label: 'Default (recommended)', hint: 'Sonnet 5 · Efficient for routine tasks', isDefault: true }] }
    c.noteList(pane('claude'), 'claude', list)
    expect(await c.currentModel(pane('claude'))).toMatchObject({ id: null, label: 'Sonnet 5' })
    // A different machine keeps its own cache.
    expect(await c.currentModel(pane('claude', 'host-b'))).toBeNull()
  })
  it('devin: the status line is authoritative — Fusion stays "Fusion"', async () => {
    const c = ctl({}, { id: 'gpt-6-1-sol', label: 'GPT-6.1 Sol' })
    c.noteScreen('w1:p1', 'devin', DEVIN_STATUS.replace('SWE-2 Max', 'Fusion'))
    expect(await c.currentModel(pane('devin'))).toMatchObject({ id: null, label: 'Fusion', at: iso(1000) })
  })
  it('devin: transcript when no status line was seen', async () => {
    const c = ctl({}, { id: 'swe-2', label: 'SWE-2' })
    expect(await c.currentModel(pane('devin'))).toMatchObject({ id: 'swe-2', label: 'SWE-2' })
  })
  it('omp: the status line gives the effort the transcript lacks', async () => {
    const c = ctl({}, { id: 'anthropic/claude-opus-5-5', label: 'Opus 5.5' })
    c.noteScreen('w1:p1', 'omp', OMP_STATUS)
    expect(await c.currentModel(pane('omp'))).toMatchObject({ label: 'Opus 5.5', effort: 'medium' })
  })
  it('omp: "auto" resolves to the level on screen', async () => {
    const c = ctl({}, { id: 'anthropic/claude-opus-5-5', label: 'Opus 5.5', effort: 'auto' })
    c.noteScreen('w1:p1', 'omp', OMP_STATUS)
    expect(await c.currentModel(pane('omp'))).toMatchObject({ effort: 'auto', effortResolved: 'medium' })
  })
  it('omp: no transcript — the status line alone, matched to a listed id', async () => {
    const c = ctl()
    c.noteScreen('w1:p1', 'omp', OMP_STATUS)
    expect(await c.currentModel(pane('omp'))).toMatchObject({ id: null, label: 'Opus 5.5', effort: 'medium' })
    c.noteList(pane('omp'), 'omp', { agent: 'omp', at: 1, options: [{ label: 'anthropic/claude-opus-5-5', hint: null }] })
    expect(await c.currentModel(pane('omp'))).toMatchObject({ id: 'anthropic/claude-opus-5-5' })
  })
  it('a phone choice wins until the transcript catches it up', async () => {
    const c = ctl({}, { id: 'old', label: 'Old', at: iso(500) })
    c.noteOverride('w1:p1', { id: null, label: 'New' })
    expect(await c.currentModel(pane('claude'))).toMatchObject({ label: 'New' })
    const caught = ctl({ transcript: async () => ({ id: 'new', label: 'New', at: iso(2000) }) })
    caught.noteOverride('w1:p1', { id: null, label: 'New' })
    // Transcript at a later date: the override expires, the id comes back.
    expect(await caught.currentModel(pane('claude'))).toMatchObject({ id: 'new', label: 'New' })
    expect(await caught.currentModel(pane('claude'))).toMatchObject({ id: 'new', label: 'New' })
  })
  it('forgetModel drops every screen cache of the pane', async () => {
    const c = ctl()
    c.noteScreen('w1:p1', 'codex', '› p\n\n  GPT-6-Sol medium · ~/demo')
    expect(await c.currentModel(pane('codex'))).not.toBeNull()
    c.forgetModel('w1:p1')
    expect(await c.currentModel(pane('codex'))).toBeNull()
  })
  it('an observed effort fills a transcript that has none', async () => {
    const c = ctl({}, { id: 'x', label: 'Opus 5.5' })
    c.noteObservedEffort('w1:p1', 'Opus 5.5', 'high')
    expect(await c.currentModel(pane('claude'))).toMatchObject({ effort: 'high' })
    const other = await ctl({}, { id: 'x', label: 'Different' }).currentModel(pane('claude'))
    expect(other?.effort ?? null).toBeNull()
  })
})
