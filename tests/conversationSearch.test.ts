import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { excerpt, foldSearch, hitsInLine, matchAt, searchFile, SEARCH_BYTES_PER_AGENT } from '../server/utils/conversationSearch'
import { localFs, type MachineFs } from '../server/utils/fsx'

describe('search in transcripts', () => {
  it('extracts the real Claude and Codex messages, without tool calls', () => {
    const claude = JSON.stringify({ type: 'assistant', timestamp: '2026-09-26T10:00:00Z', message: { content: [{ type: 'text', text: 'La réponse est Éléphant.' }, { type: 'tool_use', name: 'Bash', input: { command: 'éléphant' } }] } })
    const codex = JSON.stringify({ type: 'response_item', timestamp: '2026-09-26T11:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'éléphant bleu' }] } })
    expect(hitsInLine(claude, 'claude', 123, 'elephant')).toMatchObject([{ role: 'assistant', offset: 123, ts: '2026-09-26T10:00:00Z' }])
    expect(hitsInLine(codex, 'codex', 456, 'ELEPHANT')).toMatchObject([{ role: 'user', offset: 456 }])
    expect(hitsInLine(claude, 'claude', 123, 'bash')).toEqual([])
  })

  it('normalise casse et accents et garde un extrait lisible', () => {
    expect(foldSearch('ÉTÉ')).toBe('ete')
    expect(matchAt('Un éléphant', 'ELEPHANT')).toBe(3)
    expect(matchAt('e\u0301lephant', 'éléphant')).toBe(0)
    expect(excerpt('abc éléphant xyz', 4, 12)).toContain('éléphant')
  })

  it('bounds the bytes and the number of results, going through the most recent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hw-search-'))
    const file = path.join(dir, 'conversation.jsonl')
    const line = JSON.stringify({ type: 'response_item', timestamp: '2026-09-26T11:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'éléphant ' + 'x'.repeat(200) }] } }) + '\n'
    writeFileSync(file, line.repeat(Math.ceil(SEARCH_BYTES_PER_AGENT / Buffer.byteLength(line)) + 100))
    let bytes = 0
    const fs: MachineFs = { ...localFs, read: async (p, start, len) => { bytes += len; return localFs.read(p, start, len) } }
    const result = await searchFile(fs, file, 'codex', '', 'elephant', Date.now() + 5000, 3)
    expect(result.hits).toHaveLength(3)
    expect(result.hits[0]!.offset).toBeGreaterThan(result.hits[1]!.offset)
    expect(result.limited).toBe(true)
    expect(bytes).toBeLessThanOrEqual(SEARCH_BYTES_PER_AGENT)
    const expired = await searchFile(fs, file, 'codex', '', 'elephant', Date.now() - 1)
    expect(expired).toMatchObject({ hits: [], limited: true })
  })

  it('walks past a line too large for one window instead of stalling inside it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hw-search-'))
    try {
      const file = path.join(dir, 'conversation.jsonl')
      const early = JSON.stringify({ type: 'response_item', timestamp: '2026-09-26T11:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'early elephant note' }] } }) + '\n'
      // Larger than one window: a window inside it holds no complete line —
      // its only newline is the last byte. The walk must keep moving down.
      const giant = JSON.stringify({ type: 'progress', blob: 'y'.repeat(300 * 1024) }) + '\n'
      const late = JSON.stringify({ type: 'response_item', timestamp: '2026-09-26T11:01:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'neutral tail note' }] } }) + '\n'
      writeFileSync(file, early + giant + late)
      const result = await searchFile(localFs, file, 'codex', '', 'elephant', Date.now() + 5000)
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]!.offset).toBe(0)
      expect(result.limited).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
