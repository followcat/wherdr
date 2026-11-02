// The /api/choose OpenCode branch: the card on screen is re-derived from the
// service's pending list, and only a reply the service confirms counts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { opencodeCard } from '../server/utils/opencodePrompts'
import { sameQuestion } from '../server/utils/choices'
import { HerdrError } from '../server/utils/herdr'

afterEach(() => vi.unstubAllGlobals())

const pane = { id: 'w1:p1', agent: 'opencode', status: 'blocked' }

const PERMISSION = { id: 'per_9f3', sessionID: 'ses_example', action: 'bash', resources: ['npm test'] }
const FORM = { id: 'frm_77', sessionID: 'ses_example', title: 'Questions', fields: [{ key: 'q0', title: 'Pick one', type: 'string', options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }], custom: true }] }

async function endpoint(pending: unknown) {
  const replyPermission = vi.fn(async () => true)
  const replyForm = vi.fn(async () => true)
  for (const [name, value] of Object.entries({
    defineApi: (handler: unknown) => handler, PANE_RE: /^w1:p1$/, HerdrError,
    findPane: () => pane,
    transcripts: {
      opencodePending: async () => pending,
      opencodeReplyPermission: replyPermission,
      opencodeReplyForm: replyForm,
    },
    sameQuestion, choicesCache: new Map(), poll: () => {},
  })) vi.stubGlobal(name, value)
  const { default: handler } = await import('../server/api/choose.post')
  return { handler: handler as (e: unknown, b: Record<string, unknown>) => Promise<unknown>, replyPermission, replyForm }
}

const body = (pending: Parameters<typeof opencodeCard>[0], index: number, extra: Record<string, unknown> = {}) => {
  const card = opencodeCard(pending)!
  const option = card.choices.options[index]!
  return { pane_id: pane.id, index, label: option.label, identity: card.choices.identity, ...extra }
}

describe('the OpenCode answer route replies through the service', () => {
  it('maps the tapped option to its decision and confirms the request is gone', async () => {
    const pending = { permissions: [PERMISSION], forms: [] }
    const { handler, replyPermission, replyForm } = await endpoint(pending)
    await expect(handler({}, body(pending, 1))).resolves.toEqual({ ok: true })
    expect(replyPermission).toHaveBeenCalledWith(pane, 'per_9f3', 'always', undefined)
    expect(replyForm).not.toHaveBeenCalled()
  })

  it('refuses a stale identity without replying', async () => {
    const pending = { permissions: [PERMISSION], forms: [] }
    const { handler, replyPermission } = await endpoint(pending)
    await expect(handler({}, { ...body(pending, 0), identity: 'deadbeef' })).rejects.toMatchObject({ code: 'stale' })
    expect(replyPermission).not.toHaveBeenCalled()
  })

  it('refuses when the request is already gone from the pending list', async () => {
    const shown = { permissions: [PERMISSION], forms: [] }
    const { handler, replyPermission } = await endpoint({ permissions: [], forms: [] })
    await expect(handler({}, body(shown, 0))).rejects.toMatchObject({ code: 'stale' })
    expect(replyPermission).not.toHaveBeenCalled()
  })

  it('refuses when the service does not confirm the reply', async () => {
    const pending = { permissions: [PERMISSION], forms: [] }
    const { handler } = await endpoint(pending)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tr = (globalThis as any).transcripts
    tr.opencodeReplyPermission = async () => false
    await expect(handler({}, body(pending, 0))).rejects.toMatchObject({ code: 'stale' })
  })

  it('answers a choice form with the option value, not its label', async () => {
    const pending = { permissions: [], forms: [FORM] }
    const { handler, replyForm, replyPermission } = await endpoint(pending)
    await expect(handler({}, body(pending, 1))).resolves.toEqual({ ok: true })
    expect(replyForm).toHaveBeenCalledWith(pane, 'frm_77', 'q0', 'beta')
    expect(replyPermission).not.toHaveBeenCalled()
  })

  it('sends a free answer with its text — and only for the question shown', async () => {
    const pending = { permissions: [], forms: [FORM] }
    const { handler, replyForm } = await endpoint(pending)
    const card = opencodeCard(pending)!
    const i = card.choices.options.length - 1
    await expect(handler({}, { ...body(pending, i), text: 'my own answer', question: 'Pick one' })).resolves.toEqual({ ok: true })
    expect(replyForm).toHaveBeenCalledWith(pane, 'frm_77', 'q0', 'my own answer')
    await expect(handler({}, { ...body(pending, i), text: 'x', question: 'A different question' })).rejects.toMatchObject({ code: 'stale' })
    await expect(handler({}, { ...body(pending, i), question: 'Pick one' })).rejects.toMatchObject({ code: 'bad_text' })
    expect(replyForm).toHaveBeenCalledTimes(1)
  })
})
