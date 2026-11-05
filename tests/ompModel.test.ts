// omp models: readable labels and the model read from its transcript
// (model_change, thinking_level_change, assistant message.model).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const j = (o: unknown) => JSON.stringify(o)

import { lastModel, modelFromLine, ompModelLabel } from '../server/utils/models'
import { createTranscripts, type Transcripts } from '../server/utils/transcripts'

describe('omp model labels', () => {
  it('labels the ids readable (Claude ids with Claude\'s naming)', () => {
    expect(ompModelLabel('anthropic/claude-opus-5-5')).toBe('Opus 5.5')
    expect(ompModelLabel('anthropic/claude-haiku-4-5')).toBe('Haiku 4.5')
    expect(ompModelLabel('openrouter/z-ai/glm-5.3-flash')).toBe('Glm 5.3 flash')
    expect(ompModelLabel('web/exa')).toBe('exa')
    expect(ompModelLabel('omlx/Qwen3.8-27B-8bit')).toBe('Qwen 3.8 27B 8bit')
  })
})

describe('model in an omp transcript', () => {
  const modelChange = (model: string, role: string | undefined, ts: string) => j({
    type: 'model_change', id: 'x1', parentId: null, timestamp: ts, model, ...(role ? { role } : {}), resolvedModelIsFallback: false,
  })
  const level = (lvl: string, ts: string, configured: string | null = null) => j({
    type: 'thinking_level_change', id: 'x2', parentId: 'x1', timestamp: ts, thinkingLevel: lvl, configured,
  })
  const assistant = (model: string, ts: string) => j({
    type: 'message', timestamp: ts, message: { role: 'assistant', provider: 'anthropic', model, content: [{ type: 'text', text: 'ok' }] },
  })

  it('takes model_change (temporary switch) then merges the thinking level', () => {
    const lines = [modelChange('anthropic/claude-opus-5-5', 'temporary', 't1'), level('max', 't2')]
    expect(lastModel(lines, 'omp')).toEqual({ id: 'anthropic/claude-opus-5-5', label: 'Opus 5.5', effort: 'max', at: 't2' })
  })

  it('keeps the thinking level across later replies, the configured level ("auto") first', () => {
    const lines = [
      modelChange('anthropic/claude-opus-5-5', 'temporary', 't1'),
      level('medium', 't2', 'auto'),
      assistant('anthropic/claude-opus-5-5', 't3'),
    ]
    expect(lastModel(lines, 'omp')).toEqual({ id: 'anthropic/claude-opus-5-5', label: 'Opus 5.5', effort: 'auto', effortResolved: 'medium', at: 't3' })
    // A later explicit choice (⇧⇥) wins, the model stays.
    expect(lastModel([...lines, level('high', 't4', 'high')], 'omp')).toMatchObject({ label: 'Opus 5.5', effort: 'high', at: 't4' })
  })

  it('the assistant message.model works alone (no thinking level)', () => {
    expect(lastModel([assistant('anthropic/claude-sonnet-5', 't1')], 'omp'))
      .toEqual({ id: 'anthropic/claude-sonnet-5', label: 'Sonnet 5', effort: null, at: 't1' })
  })

  it('a thinking_level_change without a model nearby is not enough', () => {
    expect(lastModel([level('xhigh', 't1')], 'omp')).toBeNull()
  })

  it('ignores other lines and quoted text', () => {
    expect(modelFromLine(j({ type: 'message', message: { role: 'user', content: 'écris {"type":"model_change"}' } }), 'omp')).toBeNull()
    expect(modelFromLine('plain text', 'omp')).toBeNull()
  })

  it('reads the real sessions of the test machine', () => {
    // Real capture: session-only switch then a thinking level, with replies before.
    const lines = [
      assistant('anthropic/claude-sonnet-5', '2026-09-21T02:21:04.000Z'),
      modelChange('anthropic/claude-opus-5-5', 'temporary', '2026-10-02T03:03:22.848Z'),
      level('max', '2026-10-02T03:03:22.849Z'),
    ]
    expect(lastModel(lines, 'omp')).toMatchObject({ id: 'anthropic/claude-opus-5-5', label: 'Opus 5.5', effort: 'max' })
  })
})

describe('transcripts.model() for omp', () => {
  it('follows the transcript as it grows', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-omp-model-'))
    const dir = path.join(home, '.omp/agent/sessions/-x')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '2026-10-02T03-02-29-192Z_test.jsonl')
    const mc = (model: string) => j({ type: 'model_change', id: 'm1', timestamp: '2026-10-02T03:03:22.848Z', model, role: 'temporary' }) + '\n'
    writeFileSync(file, j({ type: 'session', id: 'test', cwd: '/x' }) + '\n')
    const tr: Transcripts = createTranscripts({ home, herdr: async () => ({}) })
    const pane = { id: 'w1:p1', agent: 'omp', cwd: null, agentSession: file }
    expect(await tr.model(pane)).toBeNull()
    writeFileSync(file, readFileSync(file, 'utf8') + mc('anthropic/claude-opus-5-5'))
    expect((await tr.model(pane))?.label).toBe('Opus 5.5')
    // Only new bytes are read: the level then a reply keep both the model and the level.
    const add = (o: unknown) => writeFileSync(file, readFileSync(file, 'utf8') + j(o) + '\n')
    add({ type: 'thinking_level_change', timestamp: '2026-10-02T03:03:23.000Z', thinkingLevel: 'medium', configured: 'auto' })
    add({ type: 'message', timestamp: '2026-10-02T03:04:00.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } })
    expect(await tr.model(pane)).toMatchObject({ label: 'Opus 5.5', effort: 'auto' })
    add({ type: 'thinking_level_change', timestamp: '2026-10-02T03:05:00.000Z', thinkingLevel: 'xhigh', configured: 'xhigh' })
    expect(await tr.model(pane)).toMatchObject({ label: 'Opus 5.5', effort: 'xhigh' })
    // A fresh reader (service restart) finds the level behind the last reply.
    add({ type: 'message', timestamp: '2026-10-02T03:06:00.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } })
    expect(await createTranscripts({ home, herdr: async () => ({}) }).model(pane)).toMatchObject({ label: 'Opus 5.5', effort: 'xhigh' })
  })
})

describe('omp "auto" in the transcript', () => {
  it('keeps the configured "auto" and the level it resolved to', () => {
    const line = j({ type: 'thinking_level_change', timestamp: '2026-01-01T00:00:00.000Z', thinkingLevel: 'low', configured: 'auto' })
    expect(modelFromLine(line, 'omp')).toMatchObject({ effort: 'auto', effortResolved: 'low' })
    const fixed = j({ type: 'thinking_level_change', timestamp: '2026-01-01T00:00:00.000Z', thinkingLevel: 'low', configured: 'low' })
    expect(modelFromLine(fixed, 'omp')).toEqual({ id: null, label: '', effort: 'low', at: '2026-01-01T00:00:00.000Z' })
  })
})
