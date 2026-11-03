import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ sent: [] as { method: string, params: Record<string, unknown> }[], screen: '' }))
const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

vi.mock('../server/utils/env', async (importOriginal) => ({ ...(await importOriginal()), log: () => {} }))
vi.mock('../server/utils/actions', () => ({ closePanel: async () => false }))
vi.mock('../server/utils/machines', () => ({ machineOfPane: () => null }))
vi.mock('../server/utils/state', () => ({
  READY: new Set(['idle', 'done']),
  findPane: () => ({ id: 'w1:p1', agent: 'claude', status: 'idle' }),
  poll: () => {},
  transcripts: { model: async () => ({ id: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'medium', at: null }) },
}))
vi.mock('../server/utils/herdr', () => {
  const herdr = async (method: string, params: Record<string, unknown>) => {
    calls.sent.push({ method, params })
    if (method === 'agent.prompt') calls.screen = fx('claude-effort-medium.txt')
    if (method === 'pane.send_input') {
      if ((params.keys as string[]).includes('left')) calls.screen = fx('claude-effort-low.txt')
      if ((params.keys as string[]).includes('s')) calls.screen = ''
    }
    return method === 'pane.read' ? { read: { text: calls.screen } } : {}
  }
  return {
    HerdrError: class HerdrError extends Error {
      constructor(public code: string, message: string) { super(message) }
    },
    sleep: async () => {},
    herdr,
    agentPrompt: async (target: string, text: string) => { await herdr('agent.prompt', { target, text }) },
  }
})

import { listEfforts, setEffort } from '../server/utils/modelctl'

describe('Claude /effort sequence', () => {
  beforeEach(() => { calls.sent = []; calls.screen = '' })

  it('lists without opening the slider, then sends a single /effort confirmed for the session', async () => {
    expect(await listEfforts('w1:p1')).toEqual({
      levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], current: 'medium',
    })
    expect(calls.sent).toEqual([])
    await setEffort('w1:p1', 'low')
    expect(calls.sent.filter(c => c.method === 'agent.prompt')).toEqual([
      { method: 'agent.prompt', params: { target: 'w1:p1', text: '/effort' } },
    ])
    expect(calls.sent.filter(c => c.method === 'pane.send_input').map(c => c.params.keys)).toEqual([
      ['left'], ['s'],
    ])
  })
})
