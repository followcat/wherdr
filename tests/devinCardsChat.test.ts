// The real /api/chat handler with a Devin command card kept by the real store:
// the card comes once, an unchanged poll does not send it again, and a card kept
// later comes alone, after the list the client holds (server/api/chat.get.ts).
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDevinCards } from '../server/utils/devinCards'
import type { ChatItem, ChatResponse, Pane } from '../shared/types'

const screen = (name: string) => readFileSync(new URL(`./fixtures/core-screens/${name}.txt`, import.meta.url), 'utf8')
// Before any command: no echo of the three commands on the screen.
const IDLE = readFileSync(new URL('./fixtures/devin-idle.txt', import.meta.url), 'utf8')
const T0 = Date.parse('2026-11-17T03:19:30Z')
const PANE = { id: 'w1:devin', agent: 'devin', cwd: '/home/user/acme-shop', coreAddress: 't1', workspace: 'w1' } as Pane
const U: ChatItem = { role: 'user', text: 'Reply with one word', ts: new Date(T0 - 2000).toISOString() }
const A: ChatItem = { role: 'assistant', text: 'ok', ts: new Date(T0 - 1000).toISOString() }

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

async function rig() {
  let t = T0
  let written = 0
  let query: Record<string, string> = {}
  const screens = [IDLE, screen('devin-usage-turn'), screen('devin-usage-twice')]
  const store = createDevinCards({ read: async () => screens[written]!, now: () => t, sleep: async (ms) => { t += ms }, windowMs: 3000, step: 300 })
  const send = () => store.sending(PANE, '/usage', async () => { written++; return { ok: true } })
  const transcripts = {
    chat: async (_p: unknown, o: { since?: string }) => (o.since === 'tok1'
      ? { available: true, file: 'f', token: 'tok1', start: 0, unchanged: true }
      : { available: true, file: 'f', token: 'tok1', start: 0, items: [U, A] }),
    current: async () => null,
    live: () => true,
  }
  vi.stubGlobal('defineApi', (h: unknown) => h)
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('findPane', () => PANE)
  vi.stubGlobal('HerdrError', class extends Error { constructor(public code: string, m: string) { super(m) } })
  vi.stubGlobal('takenBackOf', () => ({ hidden: [], seq: 0 }))
  vi.stubGlobal('withoutTakenBack', (items: unknown) => items)
  vi.stubGlobal('chatPasted', (items: unknown) => items)
  vi.stubGlobal('addUploadHashes', async () => {})
  vi.stubGlobal('currentModel', async () => null)
  vi.stubGlobal('transcripts', transcripts)
  vi.stubGlobal('devinCards', store)
  const read = async (q: Record<string, string>): Promise<ChatResponse> => { query = q; return (await import('../server/api/chat.get')).default({} as never) as Promise<ChatResponse> }
  return { send, read, advance: (ms: number) => { t += ms } }
}

const kinds = (items?: ChatItem[]) => (items || []).map(i => i.role)

describe('a /usage card in /api/chat', () => {
  it('comes once: the first read has it, an unchanged poll does not repeat it', async () => {
    const { send, read } = await rig()
    await send()
    const first = await read({ pane: PANE.id, n: '0' })
    expect(kinds(first.items)).toEqual(['user', 'assistant', 'devinCard'])
    expect(first.items![2]).toMatchObject({ card: { command: '/usage', windows: [{ percent: 30 }, { percent: 20 }] } })
    expect(first.token).toContain('~c1')

    const again = await read({ pane: PANE.id, since: first.token!, n: '3', from: '0' })
    expect(again.unchanged).toBe(true)
    expect(again.items).toBeUndefined()
  })

  it('a card kept later comes alone, after the list the client holds', async () => {
    const { send, read, advance } = await rig()
    await send()
    const first = await read({ pane: PANE.id, n: '0' })
    advance(10_000)
    await send()
    const next = await read({ pane: PANE.id, since: first.token!, n: '3', from: '0' })
    expect(next.keep).toBe(3)
    expect(kinds(next.items)).toEqual(['devinCard'])
    expect(next.items![0]).toMatchObject({ card: { windows: [{ percent: 32 }, { percent: 21 }] } })
  })
})
