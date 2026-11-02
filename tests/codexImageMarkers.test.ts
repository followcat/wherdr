// Image markers of Codex user messages. Codex (codex-rs/protocol models.rs)
// writes each attached local image as three content parts:
//   { input_text: '<image name=[Image #1] path="…">' }, { input_image }, { input_text: '</image>' }
// (older versions: '<image name=[Image #1]>'), then the user's text. Its
// composer puts a "[Image #1]" placeholder in that text and declares it, as a
// byte range (`text_elements`), in the event written after the message. Only
// those parts and ranges are metadata: anything the user wrote stays.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTranscripts, parseLines } from '../server/utils/transcripts'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const UPLOADS = '/home/user/.cache/herdr-web/uploads'
const j = (o: object) => JSON.stringify(o)
const text = (t: string) => ({ type: 'input_text', text: t })
const image = { type: 'input_image', image_url: PNG, detail: 'high' }
// One local image as Codex writes it.
const local = (n: number, name = `photo-${n}.jpg`) => [text(`<image name=[Image #${n}] path="${UPLOADS}/${name}">`), image, text('</image>')]
const user = (content: object[], ts = '2026-01-01T00:00:00Z') => j({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content } })
const assistant = (t: string, ts = '2026-01-01T00:00:01Z') => j({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] } })
const codex = (...lines: string[]) => parseLines(lines.join('\n') + '\n', 'codex')
const users = (...lines: string[]) => codex(...lines).filter(i => i.role === 'user')

// A composer text: strings are typed, numbers are image placeholders the
// composer inserted (declared as UTF-8 byte ranges, like Codex's TextElement).
type Piece = string | number
function compose(pieces: Piece[]) {
  let t = ''
  const elements: { byte_range: { start: number, end: number }, placeholder: string }[] = []
  for (const p of pieces) {
    if (typeof p === 'string') { t += p; continue }
    const label = `[Image #${p}]`
    const start = Buffer.byteLength(t)
    t += label
    elements.push({ byte_range: { start, end: start + Buffer.byteLength(label) }, placeholder: label })
  }
  return { text: t, elements }
}
const paths = (n: number) => Array.from({ length: n }, (_, k) => `${UPLOADS}/photo-${k + 1}.jpg`)
// The event Codex writes after the message: legacy `user_message`, or the
// paginated `item_completed` UserMessage item.
const legacyEvent = (c: ReturnType<typeof compose>, n: number) => j({ timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: c.text, images: [], local_images: paths(n), text_elements: c.elements } })
const pagedEvent = (c: ReturnType<typeof compose>, n: number) => j({ timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: 'u', item: { type: 'UserMessage', id: 'm', content: [...paths(n).map(p => ({ type: 'local_image', path: p })), { type: 'text', text: c.text, text_elements: c.elements }] } } })
// A message with `n` photos and that text, as Codex records it.
const sent = (n: number, pieces: Piece[], event: typeof legacyEvent | null = legacyEvent) => {
  const c = compose(pieces)
  const msg = user([...Array.from({ length: n }, (_, k) => local(k + 1)).flat(), text(c.text)])
  return event ? [msg, event(c, n)] : [msg]
}
const said = (n: number, pieces: Piece[], event: typeof legacyEvent | null = legacyEvent) => users(...sent(n, pieces, event))[0]!

describe('Codex image markers', () => {
  for (const [name, event] of [['legacy user_message', legacyEvent], ['paginated item_completed', pagedEvent], ['no event', null]] as const) {
    describe(name, () => {
      it('an image alone leaves no text, only the image', () => {
        const m = said(1, [1], event)
        expect(m).toMatchObject({ text: '', images: 1 })
        expect(m.ref).toMatch(/^\d+:\d+$/)
      })

      it('several images alone leave no text', () => {
        expect(said(3, [1, 2, ' ', 3], event)).toMatchObject({ text: '', images: 3 })
        expect(said(2, [1, '\n', 2, '\n'], event)).toMatchObject({ text: '', images: 2 })
      })

      it('keeps the upload path out of the text (the image is re-read from the transcript)', () => {
        const m = said(1, [1], event)
        expect(m.text).not.toContain('uploads')
        expect(m.text).not.toContain('path=')
      })
    })
  }

  for (const [name, event] of [['legacy user_message', legacyEvent], ['paginated item_completed', pagedEvent]] as const) {
    it(`removes the declared placeholders around typed text (${name})`, () => {
      expect(said(1, ['Here is the bug:\n', 1], event).text).toBe('Here is the bug:')
      expect(said(1, [1, '\nWhy is the button clipped?'], event).text).toBe('Why is the button clipped?')
      expect(said(2, ['Before ', 1, ' and after ', 2, ' the change.'], event).text).toBe('Before and after the change.')
      expect(said(2, ['First:\n', 1, '\n\nThen:\n', 2, '\n\nWhich one is right?'], event).text).toBe('First:\n\nThen:\n\nWhich one is right?')
      // Byte ranges, not character offsets.
      expect(said(1, ['Café ☕ 🐑 ', 1, ' déjà vu'], event).text).toBe('Café ☕ 🐑 déjà vu')
    })
  }

  it('the older open tag (no path) and placeholders on their own lines', () => {
    const [m] = users(user([text('<image name=[Image #1]>'), image, text('</image>'), text('<image name=[Image #2]>'), image, text('</image>'), text('[Image #1]\n[Image #2]\n')]))
    expect(m).toMatchObject({ text: '', images: 2 })
  })

  it('a remote image wrapped in <image></image> leaves no text', () => {
    const [m] = users(user([text('<image>'), image, text('</image>'), text('Compare it.')]))
    expect(m).toMatchObject({ text: 'Compare it.', images: 1 })
  })

  describe('a literal marker typed next to an attached image stays', () => {
    const literal = 'Explique littéralement `[Image #1]` dans cet exemple.'
    const quote = '> [Image #1]\nWhat does this quoted line mean?'
    const code = 'Why does this print a label?\n```\nconsole.log("[Image #1]")\n```'
    for (const typed of [literal, quote, code]) {
      it(JSON.stringify(typed.slice(0, 30)), () => {
        // The composer's placeholder after the typed text: only it goes.
        expect(said(1, [typed, '\n', 1]).text).toBe(typed)
        expect(said(1, [typed, '\n', 1], pagedEvent).text).toBe(typed)
        // Placeholder first: the literal one, later, stays too.
        expect(said(1, [1, ' ', typed]).text).toBe(typed)
        // No placeholder declared (the event says it was typed): all of it stays.
        expect(said(1, [typed]).text).toBe(typed)
        // No event at all: ambiguous, so kept as is.
        expect(said(1, [typed], null).text).toBe(typed)
        expect(said(1, [1, ' ', typed], null).text).toBe(`[Image #1] ${typed}`)
      })
    }

    it('"[Image #1]" alone, declared as typed, stays', () => {
      expect(said(1, ['[Image #1]']).text).toBe('[Image #1]')
    })

    it('without an event, only the message\'s own placeholders, each once, are a photo-only message', () => {
      expect(said(1, ['[Image #2]'], null).text).toBe('[Image #2]')
      expect(said(1, ['[Image #1] [Image #1]'], null).text).toBe('[Image #1] [Image #1]')
      expect(said(2, ['[Image #1] and [Image #2]'], null).text).toBe('[Image #1] and [Image #2]')
    })

    it('ignores declared elements that are not image placeholders', () => {
      const c = compose(['Ask ', '$skill', ' about ', 1])
      c.elements.unshift({ byte_range: { start: 4, end: 10 }, placeholder: '$skill' })
      expect(users(user([...local(1), text(c.text)]), legacyEvent(c, 1))[0]!.text).toBe('Ask $skill about')
      // A range that does not hold its placeholder is not trusted.
      const bad = compose(['See [Image #1] here'])
      bad.elements.push({ byte_range: { start: 0, end: 3 }, placeholder: '[Image #1]' })
      expect(users(user([...local(1), text(bad.text)]), legacyEvent(bad, 1))[0]!.text).toBe('See [Image #1] here')
    })

    it('the same text sent twice uses each event once', () => {
      const typedOnce = compose(['Look: [Image #1]'])
      const composed = compose(['Look: ', 1])
      expect(composed.text).toBe(typedOnce.text)
      const msgs = users(
        user([...local(1), text(typedOnce.text)]), legacyEvent(typedOnce, 1),
        user([...local(1), text(composed.text)]), legacyEvent(composed, 1),
      )
      expect(msgs.map(m => m.text)).toEqual(['Look: [Image #1]', 'Look:'])
    })
  })

  it('keeps literal markers with no image', () => {
    expect(users(user([text('Wrap it like this:\n```html\n<image name=[Image #1]>\n</image>\n```')]))[0]!.text).toBe('Wrap it like this:\n```html\n<image name=[Image #1]>\n</image>\n```')
    expect(users(user([text('</image>')]))[0]!.text).toBe('</image>')
    expect(users(user([text('See [Image #1] in the spec.')]))[0]!.text).toBe('See [Image #1] in the spec.')
  })

  it('a "</image>" part not right after an image is the user\'s', () => {
    expect(users(user([...local(1), text('</image>'), text('[Image #1]')]))[0]!.text).toBe('</image>')
  })

  it('leaves replies alone', () => {
    const r = codex(assistant('Use `</image>` and [Image #1] as written.')).find(i => i.role === 'assistant')!
    expect(r.text).toBe('Use `</image>` and [Image #1] as written.')
  })

  it('counts images and keeps their order for re-reading', () => {
    const m = said(2, ['Two shots.'])
    expect(m).toMatchObject({ text: 'Two shots.', images: 2 })
    expect(m.hashes).toHaveLength(2)
  })
})

describe('Claude and omp image tags are unchanged', () => {
  it('Claude: "[Image #1]" goes, the text stays', () => {
    const line = j({ type: 'user', timestamp: 't', message: { role: 'user', content: [
      { type: 'text', text: '[Image #1] What is wrong here?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.split(',')[1] } },
    ] } })
    const [m] = parseLines(line + '\n', 'claude', 0, '/home/user').filter(i => i.role === 'user')
    expect(m).toMatchObject({ text: 'What is wrong here?', images: 1 })
  })

  it('Claude: a text with "</image>" and no image stays as typed', () => {
    const line = j({ type: 'user', timestamp: 't', message: { role: 'user', content: 'Close it with </image>.' } })
    expect(parseLines(line + '\n', 'claude', 0, '/home/user').find(i => i.role === 'user')!.text).toBe('Close it with </image>.')
  })

  it('omp: "[Image #1, 756x477]" goes, the text stays', () => {
    const line = j({ type: 'message', id: 'a', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [
      { type: 'text', text: '[Image #1, 756x477] Is this aligned?' },
      { type: 'image', mimeType: 'image/png', data: PNG.split(',')[1] },
    ] } })
    const [m] = parseLines(line + '\n', 'omp', 0, '/home/user').filter(i => i.role === 'user')
    expect(m).toMatchObject({ text: 'Is this aligned?', images: 1 })
  })
})

describe('Codex image markers through the chat API', () => {
  // A rollout long enough to read in pages: the photo-only message sits in
  // the older slice, a text + photo message in the latest one.
  const home = mkdtempSync(path.join(tmpdir(), 'hw-codex-img-'))
  const dir = path.join(home, '.codex/sessions/2026/01/01')
  mkdirSync(dir, { recursive: true })
  const id = '00000000-0000-4000-8000-0000000001a9'
  const filler = Array.from({ length: 120 }, (_, k) => [
    user([text(`Step ${k}: ${'details '.repeat(2500)}`)], `2026-01-01T00:${String(10 + Math.floor(k / 60)).padStart(2, '0')}:${String(k % 60).padStart(2, '0')}Z`),
    assistant(`Done ${k}.`, `2026-01-01T00:${String(10 + Math.floor(k / 60)).padStart(2, '0')}:${String(k % 60).padStart(2, '0')}Z`),
  ]).flat()
  const lines = [
    j({ type: 'session_meta', payload: { id, cwd: '/home/user/acme-shop' } }),
    user([...local(1)], '2026-01-01T00:00:00Z'),
    ...sent(1, [1]),
    assistant('A login page.', '2026-01-01T00:01:05Z'),
    ...filler,
    ...sent(2, ['Before ', 1, ' and ', 2, ' after: is `[Image #1]` a label?']),
    assistant('Both differ.', '2026-01-01T01:00:05Z'),
  ]
  writeFileSync(path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`), lines.join('\n') + '\n')
  const t = createTranscripts({ home, herdr: async () => { throw new Error('no Herdr in tests') } })
  const pane = { id: 'w1:p1', agent: 'codex', cwd: '/home/user/acme-shop', agentSession: id }
  const photoMsgs = (items: { role: string, text: string, images?: number }[]) => items.filter(i => i.role === 'user' && i.images)

  it('initial load: text kept, markers gone, images re-readable', async () => {
    const r = await t.chat(pane, {})
    expect(r.available).toBe(true)
    const last = photoMsgs(r.items!).at(-1)!
    expect(last).toMatchObject({ text: 'Before and after: is `[Image #1]` a label?', images: 2 })
    expect((await t.image(pane, r.file!, (last as { ref: string }).ref, 1))!.type).toBe('image/png')
  })

  it('history: the older photo-only messages come back without markers', async () => {
    const first = await t.chat(pane, {})
    expect(first.start).toBeGreaterThan(0)
    expect(photoMsgs(first.items!).map(i => i.text)).toEqual(['Before and after: is `[Image #1]` a label?'])
    let start = first.start!
    let found: { text: string, images?: number }[] = []
    for (let n = 0; n < 20 && start > 0 && !found.length; n++) {
      const older = await t.chat(pane, { before: start })
      expect(older.older).toBe(true)
      found = photoMsgs(older.items!).filter(i => i.text === '' || /image|Image #/.test(i.text))
      start = older.start!
    }
    expect(found.map(i => [i.text, i.images])).toEqual([['', 1], ['', 1]])
  })
})
