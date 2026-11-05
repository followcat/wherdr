import { describe, expect, it } from 'vitest'
import { DEMO_REFUSAL, DemoServer } from '../app/demo/server'
import { CLAUDE_WEB, COORD, CODEX, OMP, scriptFor } from '../app/demo/scenario'
import type { ChatResponse } from '../shared/types'

// Manual clock: timers run only when the test advances time.
function clock() {
  let now = Date.parse('2026-10-09T10:00:00Z')
  let timers: { at: number, fn: () => void }[] = []
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn }) },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        timers = timers.filter(t => t !== next)
        now = next.at
        next.fn()
      }
      now = end
    },
  }
}

const chat = (s: DemoServer, pane: string, since = '') => s.handle('GET', `/api/chat?pane=${encodeURIComponent(pane)}&since=${since}`).body as ChatResponse

describe('demo server', () => {
  it('opens on a consistent session: every laid-out pane exists, questions only on waiting agents', () => {
    const s = new DemoServer(clock())
    const st = s.state()
    const ids = new Set(st.panes.map(p => p.id))
    for (const t of st.tabs || []) for (const lp of t.layout?.panes || []) expect(ids.has(lp.pane)).toBe(true)
    for (const p of st.panes) expect(Boolean(p.prompt)).toBe(p.status === 'blocked')
    expect(new Set(st.panes.map(p => p.status))).toEqual(new Set(['idle', 'working', 'blocked', 'done', null]))
  })

  it('answers a message with a scripted turn, unread when nobody watches the agent', () => {
    const c = clock()
    const s = new DemoServer(c)
    const before = chat(s, CLAUDE_WEB)
    expect(s.handle('POST', '/api/prompt', { pane_id: CLAUDE_WEB, text: 'Tidy up the README please' }).status).toBe(200)
    expect(s.pane(CLAUDE_WEB)?.status).toBe('working')
    expect(chat(s, CLAUDE_WEB).items!.at(-1)).toMatchObject({ role: 'user', text: 'Tidy up the README please' })
    c.advance(20_000)
    const after = chat(s, CLAUDE_WEB, before.token)
    expect(after.unchanged).toBeUndefined()
    expect(after.items!.at(-1)!.role).toBe('assistant')
    expect(s.pane(CLAUDE_WEB)?.status).toBe('done')
    // Nothing new since: the poll is answered "unchanged".
    expect(chat(s, CLAUDE_WEB, after.token).unchanged).toBe(true)
  })

  it('a finished turn on the agent being watched is already read', () => {
    const c = clock()
    const s = new DemoServer(c)
    s.setViewing(CLAUDE_WEB, true)
    s.handle('POST', '/api/prompt', { pane_id: CLAUDE_WEB, text: 'Tidy up the README please' })
    c.advance(20_000)
    expect(s.pane(CLAUDE_WEB)?.status).toBe('idle')
  })

  it('waits for Approve before running a command, and runs nothing on Deny', () => {
    const c = clock()
    const s = new DemoServer(c)
    s.handle('POST', '/api/prompt', { pane_id: CLAUDE_WEB, text: 'Run the tests' })
    c.advance(5_000)
    const p = s.pane(CLAUDE_WEB)!
    expect(p.status).toBe('blocked')
    expect(p.prompt?.detail?.command).toBe('npm test')
    const yes = p.prompt!.options[0]!
    expect(s.handle('POST', '/api/choose', { pane_id: CLAUDE_WEB, index: 0, label: yes.label }).status).toBe(200)
    c.advance(20_000)
    const items = chat(s, CLAUDE_WEB).items!
    expect(items.some(i => i.role === 'tool' && i.text === 'npm test')).toBe(true)
    expect(items.at(-1)!.text).toMatch(/162 tests/)

    s.handle('POST', '/api/prompt', { pane_id: CLAUDE_WEB, text: 'Run the tests again' })
    c.advance(5_000)
    const no = s.pane(CLAUDE_WEB)!.prompt!.options.length - 1
    s.handle('POST', '/api/choose', { pane_id: CLAUDE_WEB, index: no, label: 'No' })
    c.advance(20_000)
    const after = chat(s, CLAUDE_WEB).items!
    expect(after.filter(i => i.role === 'tool' && i.text === 'npm test')).toHaveLength(1)
    expect(after.at(-1)!.text).toMatch(/did not run/)
    expect(s.pane(CLAUDE_WEB)?.prompt).toBeUndefined()
  })

  it('refuses a stale answer while a question is open', () => {
    const c = clock()
    const s = new DemoServer(c)
    expect(s.handle('POST', '/api/choose', { pane_id: OMP, index: 0, label: 'Deny' }).status).toBe(409)
    expect(s.handle('POST', '/api/choose', { pane_id: OMP, index: 0, label: 'Approve' }).status).toBe(200)
    c.advance(20_000)
    // The command already shown as running gets its result, not a second line.
    const runs = chat(s, OMP).items!.filter(i => i.text === 'npm test -- export.spec.ts --repeat 20')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.omp?.exit).toBe(0)
  })

  it('holds a message typed during an approval, and sends it once the agent rests', () => {
    const c = clock()
    const s = new DemoServer(c)
    const before = chat(s, OMP).items!.length
    const r = s.handle('POST', '/api/prompt', { pane_id: OMP, text: 'Why was it flaky?', client_id: 'w-abc123' })
    expect(r).toEqual({ status: 200, body: { ok: true } })
    // Still waiting on the question, the message is listed, not in the conversation.
    expect(s.pane(OMP)).toMatchObject({ status: 'blocked', queued: [{ id: 'w-abc123', text: 'Why was it flaky?', state: 'held' }] })
    expect(chat(s, OMP).items).toHaveLength(before)
    // A second one waits behind it.
    expect(s.handle('POST', '/api/prompt', { pane_id: OMP, text: 'How do I check it?' }).status).toBe(200)
    expect(s.pane(OMP)?.queued).toHaveLength(2)

    s.handle('POST', '/api/choose', { pane_id: OMP, index: 0, label: 'Approve' })
    c.advance(60_000)
    const users = chat(s, OMP).items!.slice(before).filter(i => i.role === 'user').map(i => i.text)
    expect(users).toEqual(['Why was it flaky?', 'How do I check it?'])
    expect(s.pane(OMP)?.queued).toBeUndefined()
    expect(s.pane(OMP)?.status).toBe('done')
    expect(chat(s, OMP).items!.at(-1)!.role).toBe('assistant')
  })

  it('holds a written reply to a Claude question too, without answering it', () => {
    const c = clock()
    const s = new DemoServer(c)
    s.handle('POST', '/api/prompt', { pane_id: CLAUDE_WEB, text: 'Run the tests' })
    c.advance(5_000)
    expect(s.pane(CLAUDE_WEB)?.status).toBe('blocked')
    // The route the app takes for Claude and Codex questions (shared/sendRoute.ts).
    const r = s.handle('POST', '/api/input', { pane_id: CLAUDE_WEB, text: 'Only the unit tests', keys: ['enter'] })
    expect(r.status).toBe(200)
    expect(s.pane(CLAUDE_WEB)).toMatchObject({ status: 'blocked', queued: [{ text: 'Only the unit tests', state: 'held' }] })
    // Stop closes the question: the held message goes out.
    s.handle('POST', '/api/interrupt', { pane_id: CLAUDE_WEB })
    c.advance(1_000)
    expect(s.pane(CLAUDE_WEB)?.queued).toBeUndefined()
    expect(chat(s, CLAUDE_WEB).items!.filter(i => i.role === 'user').at(-1)!.text).toBe('Only the unit tests')
    // Keys alone are not simulated.
    expect(s.handle('POST', '/api/input', { pane_id: CLAUDE_WEB, keys: ['enter'] }).status).toBe(403)
  })

  it('takes a message while the agent works, and a command while a question is open', () => {
    const c = clock()
    const s = new DemoServer(c)
    s.handle('POST', '/api/prompt', { pane_id: COORD, text: 'Plan the next release' })
    expect(s.pane(COORD)?.status).toBe('working')
    expect(s.handle('POST', '/api/prompt', { pane_id: COORD, text: 'Why this order?' }).status).toBe(200)
    c.advance(30_000)
    expect(chat(s, COORD).items!.at(-1)!.role).toBe('assistant')
    expect(s.handle('POST', '/api/prompt', { pane_id: OMP, text: '/compact' }).status).toBe(200)
    expect(s.pane(OMP)?.queued).toBeUndefined()
  })

  it('the Codex agent finishes its turn by itself', () => {
    const c = clock()
    const s = new DemoServer(c)
    c.advance(60_000)
    expect(s.pane(CODEX)?.status).toBe('done')
  })

  it('refuses everything it does not simulate, with the demo message', () => {
    const s = new DemoServer(clock())
    expect(s.handle('POST', '/api/push/test', {})).toEqual({ status: 403, body: { error: DEMO_REFUSAL, code: 'demo' } })
    expect(s.handle('POST', '/api/space', { op: 'split' }).status).toBe(403)
    expect(s.handle('GET', '/api/machine/awake?key=x').status).toBe(404)
  })

  it('stops a working agent on interrupt', () => {
    const c = clock()
    const s = new DemoServer(c)
    s.handle('POST', '/api/prompt', { pane_id: COORD, text: 'Plan the next release' })
    expect(s.handle('POST', '/api/interrupt', { pane_id: COORD }).body).toMatchObject({ stopped: true })
    c.advance(20_000)
    expect(s.pane(COORD)?.status).toBe('idle')
    expect(chat(s, COORD).items!.at(-1)).toMatchObject({ role: 'system', text: 'Interrupted' })
  })

  it('answers a question, and asks before running what a request asks for', () => {
    expect(scriptFor('claude', 'Why did the export test fail?', 0).approval).toBeUndefined()
    expect(scriptFor('claude', 'Can you run the tests?', 0).approval).toBe('npm test')
    expect(scriptFor('codex', 'Merge it', 0).approval).toBe('git push origin HEAD')
  })
})
