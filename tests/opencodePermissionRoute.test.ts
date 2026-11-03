import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { opencodeDecision, screenChoices } from '../server/utils/choices'
import { HerdrError } from '../server/utils/herdr'

const text = readFileSync(new URL('./captures/opencode-permission-shell.txt', import.meta.url), 'utf8')
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

// The actual /api/choose endpoint with only its transport/framework bindings
// faked. The API card path is authoritative; when the pending list has no
// card, the screen-parsed permission answers by action/resources — never keys.
async function choose(index: number, match: (target: unknown) => Promise<boolean>, pending = { permissions: [], forms: [] }) {
  const pane = { id: 'w1:p1', agent: 'opencode', status: 'blocked', agentSession: 'ses_example' }
  const choices = screenChoices(text, 'opencode')!
  const herdr = vi.fn(async () => ({ read: { text } }))
  const permissionMatch = vi.fn(match)
  vi.useFakeTimers()
  for (const [name, value] of Object.entries({
    defineApi: (handler: unknown) => handler, PANE_RE: /^w1:p1$/, HerdrError,
    findPane: () => pane, herdr, screenChoices, opencodeDecision, keysFor: vi.fn(), sameQuestion: () => true,
    transcripts: {
      pendingClaudeQuestions: async () => [],
      opencodePending: async () => pending,
      opencodePermissionMatch: permissionMatch,
    },
    choicesCache: new Map(), poll: () => {},
  })) vi.stubGlobal(name, value)
  const { default: handler } = await import('../server/api/choose.post')
  return {
    herdr,
    permissionMatch,
    result: () => handler({}, { pane_id: pane.id, index, label: choices.options[index]!.label, identity: choices.identity }),
  }
}

it('answers a screen-parsed OpenCode permission by matching one pending request, never by keys', async () => {
  const r = await choose(1, async () => true)
  await expect(r.result()).resolves.toEqual({ ok: true })
  expect(r.permissionMatch).toHaveBeenCalledWith(expect.objectContaining({ agentSession: 'ses_example' }), {
    action: 'bash', resources: ['echo hello'], decision: 'always',
  })
  expect(r.herdr).toHaveBeenCalledTimes(1) // the screen re-read, no send_input
  expect(r.herdr).not.toHaveBeenCalledWith('pane.send_input', expect.anything())
})

it('refuses when the pending request no longer matches', async () => {
  const r = await choose(2, async () => false)
  await expect(r.result()).rejects.toMatchObject({ code: 'stale' })
  expect(r.herdr).not.toHaveBeenCalledWith('pane.send_input', expect.anything())
})

it('refuses a stale card identity before any reply goes out', async () => {
  const r = await choose(1, async () => true)
  const { default: handler } = await import('../server/api/choose.post')
  await expect(handler({}, { pane_id: 'w1:p1', index: 1, label: 'Always allow', identity: 'forged' })).rejects.toMatchObject({ code: 'stale' })
  expect(r.permissionMatch).not.toHaveBeenCalled()
  expect(r.herdr).not.toHaveBeenCalledWith('pane.send_input', expect.anything())
})
