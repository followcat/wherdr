// Agent models: labels and reading from transcripts (Claude, Codex).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeModelLabel, codexConfigModel, codexModelLabel, lastModel, modelFromLine,
} from '../server/utils/models'
import { createTranscripts, parseLines } from '../server/utils/transcripts'
import { type MachineFs, localFs } from '../server/utils/fsx'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const j = (o: unknown) => JSON.stringify(o)

describe('labels', () => {
  it('Claude', () => {
    expect(claudeModelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(claudeModelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(claudeModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(claudeModelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(claudeModelLabel('claude-fable-5-1[1m]')).toBe('Fable 5.1 (1M)')
    expect(claudeModelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  })
  it('Codex', () => {
    expect(codexModelLabel('gpt-6-sol')).toBe('GPT-6-Sol')
    expect(codexModelLabel('gpt-5.6-terra')).toBe('GPT-5.6-Terra')
    expect(codexModelLabel('gpt-5.5')).toBe('GPT-5.5')
  })
})

describe('model in a Claude transcript', () => {
  const assistant = (model: string, ts: string, extra = {}) => j({ type: 'assistant', timestamp: ts, message: { model, role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ...extra })
  const stdout = (text: string, ts: string, type = 'user') => (type === 'user'
    ? j({ type: 'user', timestamp: ts, message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } })
    : j({ type: 'system', subtype: 'local_command', timestamp: ts, content: `<local-command-stdout>${text}</local-command-stdout>` }))

  it('takes message.model of the last reply', () => {
    const lines = [assistant('claude-sonnet-5', 't1'), assistant('claude-opus-5-5', 't2')]
    expect(lastModel(lines, 'claude')).toEqual({ id: 'claude-opus-5-5', label: 'Opus 5.5', effort: null, at: 't2' })
  })

  it('reads the reasoning level of the reply (effort)', () => {
    const line = JSON.stringify({ ...JSON.parse(assistant('claude-opus-5-5', 't1')), effort: 'high' })
    expect(lastModel([line], 'claude')).toMatchObject({ label: 'Opus 5.5', effort: 'high' })
  })

  it('"Set model to …" after the last reply wins (change via /model)', () => {
    const lines = [assistant('claude-opus-5-5', 't1'), stdout('Set model to `Sonnet 5` for this session only', 't2')]
    expect(lastModel(lines, 'claude')).toEqual({ id: null, label: 'Sonnet 5', at: 't2' })
    // …then the next reply, made with the new model.
    expect(lastModel([...lines, assistant('claude-sonnet-5', 't3')], 'claude')!.id).toBe('claude-sonnet-5')
  })

  it('also reads outputs as system messages, "Kept model as" and the (1M context) (default) suffix', () => {
    expect(modelFromLine(stdout('Kept model as `Opus 5.5 (default)`', 't', 'system'), 'claude')!.label).toBe('Opus 5.5')
    expect(modelFromLine(stdout('Set model to `Opus 5 (1M context) (default)` and saved as your default for new sessions\u001b[2m\u001b[22m', 't'), 'claude')!.label).toBe('Opus 5 (1M)')
  })

  it('ignores synthetic replies, subagents and quoted text', () => {
    expect(modelFromLine(assistant('<synthetic>', 't'), 'claude')).toBeNull()
    expect(modelFromLine(assistant('claude-haiku-4-5-20251001', 't', { isSidechain: true }), 'claude')).toBeNull()
    expect(modelFromLine(j({ type: 'user', message: { role: 'user', content: 'écris « Set model to `X` »' } }), 'claude')).toBeNull()
  })

  it('the real test transcript', () => {
    // Test session: replies made by Opus.
    expect(lastModel(fx('claude-session.jsonl').split('\n'), 'claude')!.label).toMatch(/^(Opus|Sonnet|Haiku|Fable) /)
  })
})

describe('model in a Codex rollout', () => {
  const tc = (model: string, effort: string, ts: string) => j({ timestamp: ts, type: 'turn_context', payload: { model, effort, collaboration_mode: { settings: { model, reasoning_effort: effort } } } })
  it('takes the last turn_context, with the effort', () => {
    const lines = [tc('gpt-6-sol', 'medium', 't1'), j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } }), tc('gpt-6-luna', 'high', 't2')]
    expect(lastModel(lines, 'codex')).toEqual({ id: 'gpt-6-luna', label: 'GPT-6-Luna', effort: 'high', at: 't2' })
  })
  it('reads the default model from config.toml (top-level keys only)', () => {
    const toml = 'model = "gpt-6-sol"\nmodel_reasoning_effort = "medium"\n[profiles.x]\nmodel = "gpt-5.5"\n'
    expect(codexConfigModel(toml)).toEqual({ id: 'gpt-6-sol', label: 'GPT-6-Sol', effort: 'medium', at: null })
    expect(codexConfigModel('[tui]\nmodel = "x"')).toBeNull()
  })
})

describe('conversation: local commands of the selectors', () => {
  it('hides /model and "Kept model as", shows a real change', () => {
    const cmd = j({ type: 'system', subtype: 'local_command', timestamp: 't', content: '<command-name>/model</command-name>\n<command-args></command-args>' })
    const kept = j({ type: 'system', subtype: 'local_command', timestamp: 't', content: '<local-command-stdout>Kept model as `Opus 5.5`</local-command-stdout>' })
    const userCmd = j({ type: 'user', timestamp: 't', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-args></command-args>' } })
    const set = j({ type: 'user', timestamp: 't', message: { role: 'user', content: '<local-command-stdout>Set model to `Sonnet 4.6` for this session only</local-command-stdout>' } })
    const items = parseLines([cmd, kept, userCmd, set].join('\n'), 'claude')
    expect(items.map(i => `${i.role}:${i.text}`)).toEqual(['system:/model → Sonnet 4.6'])
  })

  it('hides the cancelled /effort slider and shows a single system confirmation', () => {
    const command = (type: 'user' | 'system') => type === 'user'
      ? j({ type, timestamp: 't', message: { role: 'user', content: '<command-name>/effort</command-name>\n<command-args></command-args>' } })
      : j({ type, subtype: 'local_command', timestamp: 't', content: '<command-name>/effort</command-name>\n<command-args></command-args>' })
    const output = (value: string) => j({ type: 'user', timestamp: 't', message: { role: 'user', content: `<local-command-stdout>${value}</local-command-stdout>` } })
    const human = j({ type: 'user', timestamp: 't', message: { role: 'user', content: 'Aide-moi' } })
    const items = parseLines([
      command('system'), output('Cancelled'), command('user'),
      output('Set effort level to low (this session only): Quick, straightforward implementation'), human,
    ].join('\n'), 'claude')
    expect(items.map(i => `${i.role}:${i.text}`)).toEqual([
      'system:Effort : low (cette session)', 'user:Aide-moi',
    ])
    expect(parseLines(output('Set effort level to high (for this session only)'), 'claude').map(i => i.text))
      .toEqual(['Effort : high (cette session)'])
    expect(parseLines(output('Set effort level to max and saved as your default'), 'claude').map(i => i.text))
      .toEqual(['Set effort level to max and saved as your default'])
  })
})

describe('transcripts.model()', () => {
  it('follows the transcript as it grows (incremental read)', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-model-'))
    const dir = path.join(home, '.claude/projects/-x')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'sess.jsonl')
    const a = (m: string) => j({ type: 'assistant', timestamp: '2026-09-26T00:00:00Z', message: { model: m, content: [] } }) + '\n'
    writeFileSync(file, a('claude-opus-5-5') + j({ type: 'user', message: { content: 'x'.repeat(700000) } }) + '\n')
    const tr = createTranscripts({ home, herdr: async () => ({}) })
    const pane = { id: 'w1:p1', agent: 'claude', cwd: null, agentSession: 'sess' }
    expect((await tr.model(pane))!.label).toBe('Opus 5.5')
    writeFileSync(file, readFileSync(file, 'utf8') + a('claude-sonnet-5'))
    expect((await tr.model(pane))!.label).toBe('Sonnet 5')
    writeFileSync(file, readFileSync(file, 'utf8') + j({ type: 'user', message: { content: 'rien' } }) + '\n')
    expect((await tr.model(pane))!.label).toBe('Sonnet 5')
  })

  it('keeps the last model while a remote read fails, and reports the failure without one', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-model-'))
    const dir = path.join(home, '.claude/projects/-x')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(file, j({ type: 'assistant', timestamp: '2026-09-26T00:00:00Z', message: { model: 'claude-opus-5-5', content: [] }, effort: 'high' }) + '\n')
    // SSH connection dropped: every file operation fails with a non-"missing" error.
    let down = false
    const drop = () => Object.assign(new Error('Connection closed'), { code: 'remote' })
    const fs: MachineFs = {
      ...localFs,
      stat: async p => { if (down) throw drop(); return localFs.stat(p) },
      read: async (p, s, n) => { if (down) throw drop(); return localFs.read(p, s, n) },
    }
    const tr = createTranscripts({ home, herdr: async () => ({}), fs })
    const pane = { id: 'w1:p1', agent: 'claude', cwd: null, agentSession: 'sess' }
    expect(await tr.model(pane)).toMatchObject({ label: 'Opus 5.5', effort: 'high' })
    writeFileSync(file, readFileSync(file, 'utf8') + j({ type: 'user', message: { content: 'x' } }) + '\n')
    down = true
    expect(await tr.model(pane)).toMatchObject({ label: 'Opus 5.5', effort: 'high' })
    // Nothing known yet (file found, then its read fails): the failure is not turned into "no model".
    const readDown: MachineFs = { ...localFs, read: async () => { throw drop() } }
    await expect(createTranscripts({ home, herdr: async () => ({}), fs: readDown }).model(pane)).rejects.toThrow('Connection closed')
  })
})
