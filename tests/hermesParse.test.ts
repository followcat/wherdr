import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { HERMES_COLUMNS, HERMES_POLICY_PREFIX, type HermesMessage, type HermesSession, hermesLineage, hermesVisible, parseHermes } from '../server/utils/hermesParse'
// @ts-expect-error untyped test helper
import { writeHermesFixture } from './helpers/hermes-fixture.mjs'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

// What the reader will do: open read-only, follow the lineage, select by name.
function read(legacy = false, from?: string) {
  const fx = writeHermesFixture({ legacy })
  dirs.push(fx.dir)
  const db = new DatabaseSync(fx.file, { readOnly: true })
  try {
    const sessions = db.prepare('SELECT * FROM sessions').all() as unknown as HermesSession[]
    const receipt = (db.prepare('SELECT value FROM state_meta WHERE key = ?').get(HERMES_POLICY_PREFIX + fx.id) as { value?: string } | undefined)?.value
    const lineage = hermesLineage(from || fx.current, sessions, receipt)
    const rows = db.prepare(`SELECT * FROM messages WHERE session_id IN (${lineage.map(() => '?').join(',')})`).all(...lineage) as unknown as HermesMessage[]
    return { fx, lineage, items: parseHermes(hermesVisible(rows), sessions) }
  } finally { db.close() }
}

const brief = (items: ReturnType<typeof parseHermes>) => items.map(i => [i.role, i.text, ...(i.out ? [i.out] : []), ...(i.images ? [i.images] : [])])

describe('hermesParse', () => {
  it('reads a compressed, reset, rewound conversation as one chat', () => {
    const { fx, lineage, items } = read()
    expect(fs.readFileSync(fx.file).readUInt8(18)).toBe(2) // WAL
    expect(lineage).toEqual(['local-chat', 'seg-2', 'seg-3'])
    expect(brief(items)).toEqual([
      ['user', 'List the files'],
      ['tool', 'ls -la', 'a.txt\nb.txt'],
      // Compaction copy: position of the first, content of the newest.
      ['assistant', 'Two files: a and b.'],
      // model_only summary and the rewound turn are hidden; multimodal content.
      ['user', 'What is this?', 1],
      // Reasoning-only answer: thinking, no empty reply.
      ['thinking', 'It looks like a diagram.'],
      ['system', 'Conversation cleared'],
      ['user', 'Fresh start'],
      ['assistant', 'Hello again.'],
    ])
    expect(items[1]).toMatchObject({ name: 'terminal', ts: '2026-01-01T12:00:01.000Z' })
  })

  it('reads an old schema without message_uid or receipt: compression only, deduplicating by id', () => {
    // No receipt: a /reset child is its own conversation.
    expect(read(true).lineage).toEqual(['seg-3'])
    const { lineage, items } = read(true, 'seg-2')
    expect(lineage).toEqual(['local-chat', 'seg-2'])
    expect(brief(items).filter(i => i[0] === 'assistant')).toEqual([
      ['assistant', 'Two files.'], ['assistant', 'Two files: a and b.'],
    ])
  })

  it('reads only columns that exist in Hermes SCHEMA_SQL', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(fs.readFileSync(new URL('./fixtures/hermes-schema.sql', import.meta.url), 'utf8'))
    for (const [table, cols] of Object.entries(HERMES_COLUMNS)) {
      const have = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
      expect(have, table).toEqual(expect.arrayContaining([...cols]))
    }
    db.close()
  })
})
