// A message of photos alone (no text) waiting to be read: same queued bubble
// as a text message, matched by its photos, gone once it lands, never twice.
import { describe, expect, it } from 'vitest'
import { isSlashCommand, photosLanded, photosOnly, uploadNames } from '../shared/queuedMatch'
import { queuedPhase } from '../shared/queuedPhase'
import { parseLines } from '../server/utils/transcripts'
import { pendingQueue, rememberSent } from '../app/utils/pendingQueue'
import type { ChatItem, ClaudeScreen } from '../shared/types'

const UP = '/home/user/.cache/herdr-web/uploads'
const A = `${UP}/2026-01-01T10-00-00-000Z-a.jpg`
const B = `${UP}/2026-01-01T10-00-01-000Z-b.png`
const photos = `${A}\n${B}`
const T0 = Date.parse('2026-01-01T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const screen = (x: Partial<ClaudeScreen>): ClaudeScreen => ({ shell: null, sent: null, queued: [], ...x })

describe('photos alone: what the message is', () => {
  it('a message starting with a photo path is not a "/" command', () => {
    expect(isSlashCommand(A)).toBe(false)
    expect(isSlashCommand(photos)).toBe(false)
    expect(isSlashCommand('/compact')).toBe(true)
    expect(isSlashCommand('  /model opus')).toBe(true)
    expect(isSlashCommand('/')).toBe(true)
    expect(isSlashCommand('/home/user/notes.txt')).toBe(false)
    expect(isSlashCommand('Look at /compact')).toBe(false)
  })
  it('photos only, their stored names', () => {
    expect(photosOnly(photos)).toBe(true)
    expect(photosOnly(`Look\n${A}`)).toBe(false)
    expect(photosOnly('text')).toBe(false)
    expect(uploadNames(photos)).toEqual(['2026-01-01T10-00-00-000Z-a.jpg', '2026-01-01T10-00-01-000Z-b.png'])
  })
  it('landed: a user message with images, or showing one of its paths', () => {
    expect(photosLanded(photos, { role: 'user', text: '', images: 2 })).toBe(true)
    expect(photosLanded(photos, { role: 'user', text: A })).toBe(true)
    expect(photosLanded(photos, { role: 'user', text: 'other' })).toBe(false)
    expect(photosLanded(photos, { role: 'assistant', text: '', images: 1 })).toBe(false)
  })
})

describe('Claude\'s queue: an entry of photos alone', () => {
  const line = (o: object) => JSON.stringify(o)
  const enqueue = (content: string, ts: string) => line({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content })
  it('kept with its image count, gone when the photos land', () => {
    const before = parseLines([enqueue('[Image #1][Image #2]', iso(T0 + 1000))].join('\n'), 'claude', 0, '/home/user')
    expect(before.queue).toEqual([{ text: '', ts: iso(T0 + 1000), images: 2 }])
    const after = parseLines([
      enqueue('[Image #1][Image #2]', iso(T0 + 1000)),
      line({ type: 'user', timestamp: iso(T0 + 5000), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: '' } }, { type: 'image', source: { type: 'base64', data: '' } }, { type: 'text', text: '[Image #1] [Image #2]' }] } }),
    ].join('\n'), 'claude', 0, '/home/user')
    expect(after.queue).toEqual([])
    expect(after.find(i => i.role === 'user')).toMatchObject({ text: '', images: 2 })
  })
  it('text with a photo: text kept, image counted', () => {
    const r = parseLines(enqueue('[Image #1]Look at this', iso(T0)), 'claude', 0, '/home/user')
    expect(r.queue).toEqual([{ text: 'Look at this', ts: iso(T0), images: 1 }])
  })
})

describe('phase on Claude\'s screen', () => {
  it('queued while "[Image #1]" is in its queue, sent once it is the last message sent', () => {
    expect(queuedPhase(photos, screen({ queued: ['[Image #1] [Image #2]'] }))).toBe('queued')
    expect(queuedPhase(photos, screen({ sent: '[Image #1] [Image #2]' }))).toBe('sent')
    expect(queuedPhase(photos, screen({ sent: 'some text' }))).toBe('queued')
    expect(queuedPhase(photos, null)).toBe('queued')
  })
  it('several photos-only messages: told apart by their number of photos', () => {
    const s = screen({ sent: '[Image #1] [Image #2]', queued: ['[Image #3]'] })
    expect(queuedPhase(photos, s)).toBe('sent')
    expect(queuedPhase(A, s)).toBe('queued')
  })
})

describe('app: queued bubbles', () => {
  const mine = (x: object = {}) => ({ id: 'm1', text: photos, at: T0, ...x })
  const base = { claude: [], items: [] as ChatItem[], screen: null }
  it('queued: one bubble with its photos', () => {
    const r = pendingQueue({ ...base, mine: [mine()] })
    expect(r).toEqual([{ id: 'm1', raw: photos, mine: true, phase: 'queued', state: null, photos: uploadNames(photos), missing: 0 }])
  })
  it('held (menu open) and failed: same bubble, with its state', () => {
    expect(pendingQueue({ ...base, mine: [mine({ state: 'held' })] })[0]).toMatchObject({ phase: 'queued', state: 'held', photos: uploadNames(photos) })
    expect(pendingQueue({ ...base, mine: [mine({ state: 'failed' })] })[0]).toMatchObject({ state: 'failed' })
  })
  it('sent: read by Claude, photos kept', () => {
    const r = pendingQueue({ ...base, mine: [mine()], screen: screen({ sent: '[Image #1] [Image #2]' }) })
    expect(r[0]).toMatchObject({ phase: 'sent', photos: uploadNames(photos) })
  })
  it('landed: no bubble any more', () => {
    expect(pendingQueue({ ...base, mine: [mine()], items: [{ role: 'user', text: '', images: 2, ts: iso(T0 + 2000) }] })).toEqual([])
  })
  it('Claude\'s own entry of the same photos: not shown twice', () => {
    const r = pendingQueue({ ...base, mine: [mine()], claude: [{ text: '', ts: iso(T0 + 500), images: 2 }] })
    expect(r.map(q => q.id)).toEqual(['m1'])
  })
  it('text and photos, Claude\'s entry ("[Image #1]" removed): not shown twice', () => {
    const text = `Look at this\n${A}`
    const r = pendingQueue({ ...base, mine: [mine({ text })], claude: [{ text: 'Look at this', ts: iso(T0 + 500), images: 1 }] })
    expect(r.map(q => q.id)).toEqual(['m1'])
  })
  it('record gone (server restarted): Claude\'s entry gets the photos remembered by the page', () => {
    const memory = rememberSent('w1:p9', [mine()])
    const r = pendingQueue({ ...base, mine: [], claude: [{ text: '', ts: iso(T0 + 500), images: 2 }], memory })
    expect(r).toEqual([{ id: `cc-${iso(T0 + 500)}`, raw: photos, mine: false, phase: 'queued', state: null, photos: uploadNames(photos), missing: 0, inAgentQueue: true }])
    const withText = rememberSent('w1:p8', [mine({ text: `Look at this\n${A}` })])
    const t = pendingQueue({ ...base, mine: [], claude: [{ text: 'Look at this', ts: iso(T0 + 500), images: 1 }], memory: withText })
    expect(t[0]).toMatchObject({ raw: `Look at this\n${A}`, photos: uploadNames(A), missing: 0 })
  })
  it('one sent, one queued, one typed on the computer: three bubbles, right phases', () => {
    const r = pendingQueue({
      ...base,
      mine: [mine(), mine({ id: 'm2', text: A, at: T0 + 1000 })],
      claude: [{ text: '', ts: iso(T0 + 1500), images: 1 }, { text: '', ts: iso(T0 + 3000), images: 1 }],
      screen: screen({ sent: '[Image #1] [Image #2]', queued: ['[Image #3]', '[Image #4]'] }),
    })
    expect(r.map(q => [q.id, q.phase, q.photos.length, q.missing])).toEqual([['m1', 'sent', 2, 0], ['m2', 'queued', 1, 0], [`cc-${iso(T0 + 3000)}`, 'queued', 0, 1]])
  })
  it('photos never seen by wherdr (typed on the computer): placeholders, no Cancel text', () => {
    const r = pendingQueue({ ...base, mine: [], claude: [{ text: '', ts: iso(T0), images: 1 }] })
    expect(r).toEqual([{ id: `cc-${iso(T0)}`, raw: '', mine: false, phase: 'queued', state: null, photos: [], missing: 1, inAgentQueue: true }])
  })
  it('Claude\'s entry already sent from wherdr and landed: not shown again', () => {
    const r = pendingQueue({ ...base, mine: [mine({ text: `Look at this\n${A}` })], items: [{ role: 'user', text: 'Look at this', images: 1, ts: iso(T0 + 2000) }], claude: [{ text: 'Look at this', ts: iso(T0 + 500), images: 1 }] })
    expect(r).toEqual([])
  })
  // herdr-core: the photo goes where `terminal.put` writes it, outside the uploads folder.
  it('herdr-core photo path: a photo, and the bubble goes once the message lands', () => {
    const core = '/home/user/.local/state/herdr-core/default/files/t1/2026-01-01T10-00-00-000Z-0a1b2c.jpg'
    expect(uploadNames(`Look at this\n${core}`)).toEqual(['2026-01-01T10-00-00-000Z-0a1b2c.jpg'])
    expect(uploadNames('/home/user/notes/2026-01-01T10-00-00-000Z-0a1b2c.txt')).toEqual([])
    const sent = mine({ text: `Look at this\n${core}` })
    expect(pendingQueue({ ...base, mine: [sent] })[0]).toMatchObject({ photos: ['2026-01-01T10-00-00-000Z-0a1b2c.jpg'] })
    expect(pendingQueue({ ...base, mine: [sent], items: [{ role: 'user', text: 'Look at this', images: 1, ts: iso(T0 + 2000) }] })).toEqual([])
  })
})
