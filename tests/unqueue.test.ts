// "Cancel" a queued message in Claude Code: reading the input field from the
// screen, and ↑ / clear / requeue sequence played against a
// fake Claude imitating the observed one (2.1.283, hwtest session).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { clearKeys, findQueued, inputBox, msgText, unqueueClaude, unqueueDevin } from '../server/utils/unqueue'
import { canCancelQueued, restoreDraft } from '../app/utils/queuedCancel'
import type { ChatItem, ClaudeQueueEntry, Pane } from '../shared/types'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const E = '\x1b'
const RULE = `${E}[38;2;80;80;80m${'─'.repeat(40)}${E}[0m\r`
// ANSI screens captured on the real Claude Code (simplified).
const queuedLine = (t: string) => `${E}[0m${E}[38;2;80;80;80m${E}[48;2;55;55;55m❯ ${E}[0m${E}[38;2;153;153;153m${E}[48;2;55;55;55m${t}${E}[0m\r`
const screen = (queue: string[], input: string[]) => [
  '  12. La mer est salée.',
  ...queue.map(queuedLine),
  RULE,
  input.length
    ? [`${E}[0m${E}[38;2;153;153;153m❯ ${E}[0m${input[0]}\r`, ...input.slice(1).map(l => `  ${l}\r`)].join('\n')
    : `${E}[0m${E}[38;2;153;153;153m❯ ${E}[0m${queue.length ? `${E}[2mPress up to edit queued messages${E}[0m` : ''}\r`,
  RULE,
  '  ⏸ manual mode on · ← for agents',
].join('\n')

describe('champ de saisie de Claude Code', () => {
  it('empty, with or without grayed-out help text', () => {
    expect(inputBox(screen([], []))).toBe('')
    expect(inputBox(screen(['Message en file'], []))).toBe('')
  })
  it('reads the typed text, over several lines, without confusing the queue', () => {
    expect(inputBox(screen(['A'], ['Premier en file', '[Pasted text #1 +11 lines]']))).toBe('Premier en file\n[Pasted text #1 +11 lines]')
    expect(inputBox('❯ abc\r')).toBe('abc')
  })
  it('not found (menu, other screen)', () => {
    expect(inputBox('Do you trust this folder?\n❯ 1. Yes')).toBeNull()
  })
  // Fresh Claude Code 2.1.292 (hwtest session): 'Try "…"' placeholder.
  it('a fresh session\'s placeholder is not typed text, in color or not', () => {
    expect(inputBox(fx('claude-field-placeholder.ansi'))).toBe('')
    expect(inputBox(fx('claude-field-placeholder-nocolor.txt'))).toBe('')
  })
  it('a real draft is typed text, even with a grayed-out completion after it', () => {
    expect(inputBox(fx('claude-field-draft.ansi'))).toBe('draft text')
    const ghost = fx('claude-field-draft.ansi').replace('draft text', `draft te${E}[0m${E}[2;38;5;244mxt to complete${E}[0m`)
    expect(inputBox(ghost)).toBe('draft te')
    // Dim switched off by SGR 22 only: what follows is typed again.
    expect(inputBox(`❯\u00a0 ${E}[2mhint${E}[22m typed\r`)).toBe('typed')
  })
  it('a colored screen keeps a typed "Try …" text', () => {
    expect(inputBox(fx('claude-field-draft.ansi').replace('draft text', 'Try "this"'))).toBe('Try "this"')
    const plain = fx('claude-field-placeholder-nocolor.txt')
    expect(inputBox(plain.replace(/Try "[^"]*"/, 'draft text'))).toBe('draft text')
  })
  it('clearing keys: Ctrl+U then Backspace per line, bounded', () => {
    expect(clearKeys(1)).toEqual(['ctrl+u', 'backspace', 'ctrl+u', 'backspace', 'ctrl+u', 'backspace'])
    expect(clearKeys(10000).length).toBe(400)
  })
  it('texte sans chemins de photos', () => {
    expect(msgText('Regarde\n/home/user/.cache/herdr-web/uploads/a.jpg')).toBe('Regarde')
  })
})

// Fake Claude: queue, input field, conversation. ↑ brings the whole queue
// into the field (popAll); `take` simulates the end of turn that takes the queue.
function fakeClaude(queue: string[], opts: { take?: boolean, lagChat?: number, stuck?: boolean, typed?: string[] } = {}) {
  const st = { queue: [...queue], input: [...(opts.typed || [])] as string[], items: [] as ChatItem[], sent: [] as string[], keys: [] as string[], lag: opts.lagChat || 0 }
  // "[Image #1]" in a queued text: a photo (Claude's entry keeps its count, not its tag).
  const q = (): ClaudeQueueEntry[] => st.queue.map((text) => {
    const images = (text.match(/\[Image #\d+\]/g) || []).length
    return { text: text.replace(/\[Image #\d+\]/g, '').trim(), ts: null, ...(images ? { images } : {}) }
  })
  let shown = q()
  const deps = {
    screen: async () => screen(st.queue, st.input),
    keys: async (keys: string[]) => {
      st.keys.push(...keys)
      for (const k of keys) {
        if (k === 'up') {
          if (opts.take) {
            st.items.push({ role: 'user', text: st.queue.join('\n'), ts: null })
            st.queue = []
            st.input = ['message précédent']
          } else {
            st.input = st.queue.flatMap(t => t.split('\n'))
            st.queue = []
          }
        } else if (k === 'ctrl+u' && !opts.stuck) {
          if (st.input.length) st.input[st.input.length - 1] = ''
        } else if (k === 'backspace' && !opts.stuck) {
          if (st.input.length && !st.input[st.input.length - 1]) st.input.pop()
        }
      }
    },
    chat: async () => {
      // Transcript lagging `lag` reads behind the real state.
      if (st.lag > 0) st.lag--
      else shown = q()
      return { queue: shown, items: [...st.items] }
    },
    prompt: async (t: string) => {
      if (st.input.length) throw new Error('le champ aurait été envoyé avec')
      st.sent.push(t)
      st.queue.push(t)
    },
    sleep: async () => {},
  }
  return { st, deps }
}

describe('annuler un message en file de Claude', () => {
  it('the only message: recalled, field cleared, nothing requeued', async () => {
    const { st, deps } = fakeClaude(['Message en file\ndeuxième ligne'])
    expect(await unqueueClaude(deps, 'Message en file\ndeuxième ligne')).toEqual({ requeued: [], images: 0, lost: 0 })
    expect(st.keys[0]).toBe('up')
    expect(st.input).toEqual([])
    expect(st.queue).toEqual([])
  })

  it('several: the others are requeued, in order, original text', async () => {
    const { st, deps } = fakeClaude(['Premier', 'Collé\nsur\ntrois lignes', 'Troisième'])
    const r = await unqueueClaude({ ...deps, original: e => (e.text === 'Premier' ? 'Premier\n/home/user/.cache/herdr-web/uploads/p.jpg' : e.text) }, 'Collé\nsur\ntrois lignes')
    expect(r.requeued).toEqual(['Premier\n/home/user/.cache/herdr-web/uploads/p.jpg', 'Troisième'])
    expect(st.queue).toEqual(['Premier\n/home/user/.cache/herdr-web/uploads/p.jpg', 'Troisième'])
    expect(st.input).toEqual([])
  })

  it('photos alone: its entry (images, no text) leaves the queue, the others are requeued with their photos', async () => {
    const mine = '/home/user/.cache/herdr-web/uploads/a.jpg'
    const other = '/home/user/.cache/herdr-web/uploads/b.jpg'
    const { st, deps } = fakeClaude(['Premier', '[Image #1]', '[Image #2]'])
    const r = await unqueueClaude({ ...deps, original: e => (e.text ? e.text : other) }, mine)
    expect(r.requeued).toEqual(['Premier', other])
    expect(st.input).toEqual([])
  })

  it('photos alone already taken: refused without touching the terminal', async () => {
    const { st, deps } = fakeClaude(['Texte'])
    await expect(unqueueClaude(deps, '/home/user/.cache/herdr-web/uploads/a.jpg')).rejects.toMatchObject({ code: 'already_read' })
    expect(st.keys).toEqual([])
  })

  it('lagging transcript: ↑ brought back the whole queue, nothing is lost', async () => {
    const { st, deps } = fakeClaude(['A', 'B'], { lagChat: 100 })
    const r = await unqueueClaude(deps, 'B')
    expect(r.requeued).toEqual(['A'])
    expect(st.queue).toEqual(['A'])
  })

  it('already read (no longer in the queue): refused without touching the terminal', async () => {
    const { st, deps } = fakeClaude(['Autre chose'])
    await expect(unqueueClaude(deps, 'Mon message')).rejects.toMatchObject({ code: 'already_read' })
    expect(st.keys).toEqual([])
  })

  it('race: the turn takes the queue just before ↑ → history erased, warned', async () => {
    const { st, deps } = fakeClaude(['Mon message'], { take: true })
    await expect(unqueueClaude(deps, 'Mon message')).rejects.toMatchObject({ code: 'already_read' })
    expect(st.input).toEqual([])
    expect(st.sent).toEqual([])
  })

  it('agent field busy (draft typed on the computer): left untouched', async () => {
    const { st, deps } = fakeClaude(['Mon message'], { typed: ['brouillon'] })
    await expect(unqueueClaude(deps, 'Mon message')).rejects.toMatchObject({ code: 'input_busy' })
    expect(st.keys).toEqual([])
  })

  it('text and photo: the number of photos of its entry is returned', async () => {
    const { deps } = fakeClaude(['Avant', '[Image #1]Regarde ça'])
    const r = await unqueueClaude(deps, 'Regarde ça\n/home/user/.cache/herdr-web/uploads/a.jpg')
    expect(r).toEqual({ requeued: ['Avant'], images: 1, lost: 0 })
  })

  it('other entries with photos of unknown path (queued on the computer): counted as lost, never invented', async () => {
    const { st, deps } = fakeClaude(['[Image #1]Capture', 'Mon message', '[Image #2]'])
    const r = await unqueueClaude({ ...deps, original: e => (e.text ? e.text : null) }, 'Mon message')
    expect(r.requeued).toEqual(['Capture'])
    expect(r.lost).toBe(2)
    expect(st.queue).toEqual(['Capture'])
  })

  it('other entries whose photos are known: requeued with them, nothing lost', async () => {
    const path = '/home/user/.cache/herdr-web/uploads/b.jpg'
    const { deps } = fakeClaude(['[Image #1]Capture', 'Mon message'])
    const r = await unqueueClaude({ ...deps, original: e => `${e.text}\n${path}` }, 'Mon message')
    expect(r).toEqual({ requeued: [`Capture\n${path}`], images: 0, lost: 0 })
  })

  it('field impossible to clear: error, and above all nothing requeued', async () => {
    const { st, deps } = fakeClaude(['A', 'B'], { stuck: true })
    await expect(unqueueClaude(deps, 'B')).rejects.toMatchObject({ code: 'clear_failed' })
    expect(st.sent).toEqual([])
  })
})

// Fake Devin (v3000.x): "○" rows = its own queue, the "❭" line its boxed
// field. ↑ pulls the NEWEST queue entry into the field; Ctrl+Enter pushes
// the field's text back to the queue's end. Screen shape from the probe.
function fakeDevin(queue: string[], opts: { field?: string, take?: boolean, intruder?: boolean } = {}) {
  const st = { queue: [...queue], field: opts.field ?? '', keys: [] as string[], typed: [] as string[] }
  const draw = () => [
    '❭ an earlier message',
    ' ⏺ /tmp',
    ...(st.queue.length ? [`── ${st.queue.length} queued ── ↑ edit · ↵ send now ──`, ...st.queue.map(t => `○ ${t}`)] : []),
    '─── Run a 60-Second Sleep Command ───',
    `❭ ${st.field || 'Press Enter to send queued messages now'}`,
    '───',
    'SWE-2 Max   Context: 16k / 262k tokens (6%)',
  ].join('\n')
  const deps = {
    screen: async () => draw(),
    type: async (t: string) => { st.typed.push(t); st.field = t },
    keys: async (keys: string[]) => {
      st.keys.push(...keys)
      for (const k of keys) {
        if (k === 'up') {
          // `take`: the turn took the queue first — ↑ recalls history instead.
          if (opts.take) { st.queue = []; st.field = 'previous prompt (history)' }
          // `intruder`: a message queued from elsewhere just before our ↑.
          else if (opts.intruder) { opts.intruder = false; st.queue.push('intruder just queued'); st.field = st.queue.pop()! }
          else if (st.queue.length) st.field = st.queue.pop()!
          else st.field = 'previous prompt (history)'
        } else if (k === 'ctrl+u') st.field = ''
        else if (k === 'backspace') st.field = st.field.slice(0, -1)
        else if (k === 'ctrl+enter') { if (st.field) st.queue.push(st.field); st.field = '' }
      }
    },
    sleep: async () => {},
  }
  return { st, deps }
}

describe('cancel a message in Devin’s own queue', () => {
  it('the newest: one ↑ pulls it into the field, cleared, nothing requeued', async () => {
    const { st, deps } = fakeDevin(['first', 'mine second'])
    const r = await unqueueDevin(deps, 'mine second')
    expect(r.requeued).toEqual([])
    expect(st.queue).toEqual(['first'])
    expect(st.field).toBe('')
  })

  it('a middle one: the newer entries are popped, requeued in order', async () => {
    const { st, deps } = fakeDevin(['older', 'mine', 'newer one', 'newest one'])
    const r = await unqueueDevin(deps, 'mine')
    expect(r.requeued).toEqual(['newer one', 'newest one'])
    expect(st.queue).toEqual(['older', 'newer one', 'newest one'])
    expect(st.field).toBe('')
    // Full field text requeued, not the (possibly cut) screen row.
    expect(st.typed).toEqual(['newer one', 'newest one'])
  })

  it('the oldest: popped one by one, all the others requeued', async () => {
    const { st, deps } = fakeDevin(['mine oldest', 'b', 'c'])
    const r = await unqueueDevin(deps, 'mine oldest')
    expect(r.requeued).toEqual(['b', 'c'])
    expect(st.queue).toEqual(['b', 'c'])
  })

  it('not in the queue: refused without touching the terminal', async () => {
    const { st, deps } = fakeDevin(['other'])
    await expect(unqueueDevin(deps, 'mine')).rejects.toMatchObject({ code: 'already_read' })
    expect(st.keys).toEqual([])
  })

  it('queue gone meanwhile (↑ pulled a history line): refused, nothing requeued', async () => {
    const { st, deps } = fakeDevin(['other'], { take: true })
    await expect(unqueueDevin(deps, 'other')).rejects.toMatchObject({ code: 'already_read' })
    expect(st.typed).toEqual([])
    expect(st.queue).toEqual([])
  })

  it('a foreign entry queued meanwhile: busy, and it is put back — nothing lost', async () => {
    const { st, deps } = fakeDevin(['other'], { intruder: true })
    await expect(unqueueDevin(deps, 'other')).rejects.toMatchObject({ code: 'busy' })
    expect(st.queue).toEqual(['other', 'intruder just queued'])
    expect(st.field).toBe('')
  })

  it('a draft in the field is left alone', async () => {
    const { st, deps } = fakeDevin(['mine'], { field: 'draft typed on the computer' })
    await expect(unqueueDevin(deps, 'mine')).rejects.toMatchObject({ code: 'input_busy' })
    expect(st.keys).toEqual([])
    expect(st.field).toBe('draft typed on the computer')
  })
})

describe('record of the message to cancel', () => {
  const list = [
    { id: 'a', text: 'ok' },
    { id: 'b', text: 'ok\n/home/user/.cache/herdr-web/uploads/b.jpg' },
  ]
  it('by id first: an earlier message starting the same way is not taken instead', () => {
    expect(findQueued(list, 'ok\n/home/user/.cache/herdr-web/uploads/b.jpg', 'b')).toBe(list[1])
  })
  it('by text when the id is unknown (Claude\'s own entry)', () => {
    expect(findQueued(list, 'ok', undefined)).toBe(list[0])
    expect(findQueued(list, 'autre chose', 'zz')).toBeUndefined()
  })
})

describe('bouton et brouillon', () => {
  const pane = (x: Partial<Pane>) => ({ id: 'w1:p1', agent: 'claude', status: 'working', ...x }) as Pane
  it('button: Claude working, or message not sent yet', () => {
    expect(canCancelQueued(pane({}))).toBe(true)
    expect(canCancelQueued(pane({ status: 'idle' }))).toBe(false)
    expect(canCancelQueued(pane({ status: 'blocked' }))).toBe(false)
    expect(canCancelQueued(pane({ agent: 'codex' }))).toBe(false)
    expect(canCancelQueued(pane({ agent: 'codex', status: 'idle', pendingPrompt: true }))).toBe(true)
    expect(canCancelQueued(undefined)).toBe(false)
  })
  it('text put back before the draft, photos attached only once', () => {
    const d = { text: 'déjà tapé', atts: [] as { url: string, path: string | null, name?: string }[] }
    const msg = 'Regarde ça\n/home/user/.cache/herdr-web/uploads/2026-09-26T00-36-39-393Z-4fa305.jpg'
    restoreDraft(d, msg)
    restoreDraft(d, msg)
    expect(d.text).toBe('Regarde ça\nRegarde ça\ndéjà tapé')
    expect(d.atts).toEqual([{ url: '/uploads/2026-09-26T00-36-39-393Z-4fa305.jpg', path: '/home/user/.cache/herdr-web/uploads/2026-09-26T00-36-39-393Z-4fa305.jpg', name: '2026-09-26T00-36-39-393Z-4fa305.jpg' }])
  })
  it('photos only: the photos come back, no text', () => {
    const d = { text: '', atts: [] as { url: string, path: string | null, name?: string }[] }
    restoreDraft(d, '/home/user/.cache/herdr-web/uploads/a.jpg\n/home/user/.cache/herdr-web/uploads/b.jpg')
    expect(d.text).toBe('')
    expect(d.atts.map(a => a.name)).toEqual(['a.jpg', 'b.jpg'])
  })
  it('photos and attached files together, with the reply marker of an earlier version', () => {
    const d = { text: '', atts: [] as { url: string, path: string | null, name?: string, file?: unknown, ref?: string }[], reply: null as unknown }
    restoreDraft(d as never, '↳ Replying to your message from 14:22 ("La mer")\n\nRegarde\n/home/user/.cache/herdr-web/uploads/a.jpg\n@/home/user/.cache/herdr-web/files/notes.md')
    expect(d.text).toBe('↳ Quote message 14:22 : La mer —\nRegarde')
    expect(d.atts.map(a => [a.name, Boolean(a.file)])).toEqual([['a.jpg', false], ['notes.md', true]])
  })
})
