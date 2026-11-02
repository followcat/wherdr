// Pasted message (<pasted_content>) and queue: bug t-0009, a multi-line
// send stayed "queued" and its reply disappeared.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseLines, unwrapPasted } from '../server/utils/transcripts'
import { landed, queuedDone } from '../server/utils/queued'
import type { ChatItem } from '../shared/types'

const items = parseLines(readFileSync(new URL('./fixtures/claude-queue.jsonl', import.meta.url), 'utf8'), 'claude', 0, '/home/user')
const seq = items.filter(i => i.role === 'user' || i.role === 'assistant').map(i => `${i.role}:${i.text}`)

describe('pasted message', () => {
  it('removes the wrapper, closing tag with id included', () => {
    expect(unwrapPasted('\n\n<pasted_content id="1">\nA\nB\n</pasted_content id="1">\n\n')).toBe('A\nB')
    expect(unwrapPasted('voici :\n<pasted_content>\nA\n</pasted_content>')).toBe('voici :\nA')
    expect(unwrapPasted('<task-notification>x')).toBe('<task-notification>x')
  })

  it('shows the message as a user message, reply in its place', () => {
    expect(seq).toEqual([
      'user:Vérifie le calcul',
      'assistant:Le calcul est prêt.',
      'assistant:J\'attends ton choix.',
      'user:- Le total est correct\n- <b>Arrondi</b> à ajuster',
      'assistant:Je corrige l\'arrondi.',
      'user:Le bouton est trop petit.',
      'assistant:Je regarde le bouton.',
      'user:Puis ajoute un test\npour zéro',
      'assistant:Test zéro ajouté.',
      'user:Et pour -1, stp ?',
      'assistant:Cas négatif ajouté.',
    ])
    expect(items.find(i => i.text.startsWith('Le bouton'))!.images).toBe(1)
  })
})

describe('file de Claude', () => {
  it('purges handled entries, with or without dequeue, modified text included', () => {
    // "Puis ajoute…": wrapped, no dequeue; "Et le cas
    // négatif ?": rewritten, out at the end of the turn; task
    // notifications are never shown.
    expect(items.queue).toEqual([{ text: 'Toujours en attente', ts: '2026-09-26T09:25:00.000Z' }])
  })
})

describe('envoi en attente de wherdr', () => {
  const at = Date.parse('2026-09-26T09:22:40.000Z')
  const q = { id: 'x', at, text: '- Le total est correct\n- <b>Arrondi</b> à ajuster' }
  const now = at + 60000

  it('is matched with the pasted message', () => {
    expect(queuedDone(q, items, false, now)).toBe(true)
  })

  it('modified text: handled once the agent is idle and the reply written', () => {
    const other = { ...q, text: 'texte que Claude a réécrit' }
    expect(queuedDone(other, items, false, now)).toBe(false)
    expect(queuedDone(other, items, true, now)).toBe(true)
    const noReply: ChatItem[] = [{ role: 'user', text: 'réécrit', ts: '2026-09-26T09:22:52.000Z' }]
    expect(queuedDone(other, noReply, true, now)).toBe(false)
  })

  it('stays queued as long as nothing is written after sending', () => {
    const late = { ...q, text: 'autre chose', at: Date.parse('2026-09-26T09:30:00.000Z') }
    expect(queuedDone(late, items, true, late.at + 1000)).toBe(false)
    // Two hours later: still not taken (checkSent reports it as not seen).
    expect(queuedDone(late, items, true, late.at + 2 * 3600e3)).toBe(false)
  })
})

describe('OpenCode shell mode', () => {
  const at = Date.parse('2026-11-02T09:00:00.000Z')
  const shell: ChatItem[] = [{ role: 'tool', name: 'shell', text: 'echo hi', out: 'hi\n', ts: '2026-11-02T09:00:01.000Z' }]

  it('matches "!cmd" with the shell transcript row, not a user message', () => {
    expect(queuedDone({ text: '!echo hi', at }, shell, false, at + 60000, 'opencode')).toBe(true)
    expect(landed({ text: '!echo hi', at }, shell, at + 60000, 'opencode')).toBe(true)
  })

  it("keeps another agent's \"!cmd\" out of OpenCode's shell rows", () => {
    expect(queuedDone({ text: '!echo hi', at }, shell, false, at + 60000, 'claude')).toBe(false)
    expect(landed({ text: '!echo hi', at }, shell, at + 60000, 'claude')).toBe(false)
  })

  it('does not take a different command as the same run', () => {
    expect(queuedDone({ text: '!echo bye', at }, shell, false, at + 60000, 'opencode')).toBe(false)
    expect(landed({ text: '!echo bye', at }, shell, at + 60000, 'opencode')).toBe(false)
  })
})
