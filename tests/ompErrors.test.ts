// omp errors (provider failures, retries) in the conversation: the turns omp
// writes with `stopReason: "error"` and an empty content, shown the way omp's
// terminal shows them when it replays a session.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../shared/types'
import { createTranscripts, parseLines } from '../server/utils/transcripts'

const fixture = readFileSync(new URL('./fixtures/omp-errors.jsonl', import.meta.url), 'utf8')
const HOME = '/home/user'
const CHECK_IN = 'Autopilot: Regular check-in\nBoard context: no pending replies.'
const USAGE = '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-02-01 at 00:00 UTC."},"request_id":"req_0001"}'
const RATE = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_0002"}'
const STALLED = 'Retry budget exhausted after 2 retries: Anthropic stream stalled while waiting for the next event'
const CREDIT = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_0004"}'

const view = (items: ChatItem[]) => items.map(i => `${i.role}:${i.name ? `${i.name} ` : ''}${i.text}${i.error ? ' !' : ''}`)

describe('omp errors', () => {
  it('shows each error once, between the check-ins and actions around it', () => {
    expect(view(parseLines(fixture, 'omp', 0, HOME))).toEqual([
      `user:${CHECK_IN}`,
      'assistant:Checking the board.',
      'tool:Bash Listing tasks',
      `notice:error ${USAGE} !`,
      `user:${CHECK_IN}`,
      `notice:error ${RATE} !`,
      `user:${CHECK_IN}`,
      // The two attempts omp retried (superseded) stay hidden, like in omp.
      `notice:error ${STALLED} !`,
      `user:${CHECK_IN}`,
      // A recovered attempt: one line, not an error.
      'system:Retried after an error',
      'assistant:Nothing new on the board.',
      `user:${CHECK_IN}`,
      `notice:error ${CREDIT} !`,
      // Esc keeps its line; a silent abort shows nothing.
      'system:Interrupted',
    ])
  })

  it('keeps the error of a turn that wrote something before failing, after what it wrote', () => {
    const line = JSON.stringify({ type: 'message', id: 'x', timestamp: '2026-01-01T00:00:00Z', message: {
      role: 'assistant', content: [{ type: 'text', text: 'Starting.' }], stopReason: 'error', errorMessage: 'Anthropic stream stalled while waiting for the next event',
    } })
    expect(view(parseLines(`${line}\n`, 'omp', 0, HOME))).toEqual([
      'assistant:Starting.',
      'notice:error Anthropic stream stalled while waiting for the next event !',
    ])
  })

  it('shows an error once when it arrives, and the same list when the history is loaded again', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-omp-errors-'))
    const dir = path.join(home, '.omp/agent/sessions/-proj')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '2026-01-01T10-00-00-000Z_s-errors.jsonl')
    const lines = fixture.trimEnd().split('\n')
    // Up to the first check-in's actions, then the usage limit arrives.
    writeFileSync(file, `${lines.slice(0, 4).join('\n')}\n`)
    const t = createTranscripts({ home, herdr: async () => { throw new Error('no Herdr') } })
    const pane = { id: 'wE:p1', agent: 'omp', cwd: '/home/user/proj', agentSession: file }
    const first = await t.chat(pane, {})
    expect(view(first.items!)).toEqual([`user:${CHECK_IN}`, 'assistant:Checking the board.', 'tool:Bash Listing tasks'])

    writeFileSync(file, `${lines.slice(0, 5).join('\n')}\n`)
    const live = await t.chat(pane, { since: first.token, from: first.start })
    expect(live.rewritten).toBeUndefined()
    expect(view(live.items!).filter(x => x.startsWith('notice:error'))).toEqual([`notice:error ${USAGE} !`])

    // Every error of the session, then a full reload: the same list, nothing twice.
    writeFileSync(file, fixture)
    const later = await t.chat(pane, { since: live.token, from: live.start })
    const reload = await t.chat({ ...pane, id: 'wE:p2' }, {})
    expect(view(later.items!)).toEqual(view(reload.items!))
    expect(view(reload.items!)).toEqual(view(parseLines(fixture, 'omp', 0, HOME)))
  })

  it('replaces a retried error once omp marks it recovered (the file is rewritten)', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-omp-retry-'))
    const dir = path.join(home, '.omp/agent/sessions/-proj')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '2026-01-01T10-00-00-000Z_s-retry.jsonl')
    const ask = JSON.stringify({ type: 'message', id: 'u1', timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: CHECK_IN }], attribution: 'user' } })
    const failed = { type: 'message', id: 'a1', timestamp: '2026-01-01T10:00:01Z', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Anthropic stream stalled while waiting for the next event' } }
    const reply = JSON.stringify({ type: 'message', id: 'a2', timestamp: '2026-01-01T10:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } })
    writeFileSync(file, `${ask}\n${JSON.stringify(failed)}\n`)
    const t = createTranscripts({ home, herdr: async () => { throw new Error('no Herdr') } })
    const pane = { id: 'wR:p1', agent: 'omp', cwd: '/home/user/proj', agentSession: file }
    const during = await t.chat(pane, {})
    expect(view(during.items!)).toEqual([`user:${CHECK_IN}`, 'notice:error Anthropic stream stalled while waiting for the next event !'])

    // omp rewrites the session in place (temporary file, then rename) to mark the attempt.
    const marked = { ...failed, message: { ...failed.message, retryRecovery: { kind: 'auto-retry', status: 'recovered', attempt: 1, recovery: 'plain', note: 'error; retried' } } }
    writeFileSync(`${file}.tmp`, `${ask}\n${JSON.stringify(marked)}\n${reply}\n`)
    renameSync(`${file}.tmp`, file)
    const after = await t.chat(pane, { since: during.token, from: during.start })
    expect(view(after.items!)).toEqual([`user:${CHECK_IN}`, 'system:Retried after an error', 'assistant:Done.'])
  })
})
