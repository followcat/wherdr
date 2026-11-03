import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  sent: [] as { method: string, params: Record<string, unknown> }[],
  pane: {} as Record<string, unknown>,
  model: null as { id: string, label: string, at: string | null } | null,
  listRuns: 0,
  listOut: '',
}))

const SAMPLE = `Available models  ·  95 models

Open Source

deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning
deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)
z-ai/glm-5.3-flash                     fast, affordable GLM coding with 1M context

Google

google/gemini-3.8-flash                multimodal reasoning for documents and agent workflows

Pass the full id, or just the short name after the last "/":
cmd --model moonshotai/kimi-k2.5

Docs:  https://commandcode.ai/docs/reference/cli/models

Decision models (headless only)
typesafe/jev  typed questions in, probabilities out, $0.042 per 1M input tokens
`

vi.mock('../server/utils/env', () => ({ log: () => {} }))
vi.mock('../server/utils/actions', () => ({ closePanel: async () => false }))
vi.mock('../server/utils/machines', () => ({ machineOfPane: () => null }))
vi.mock('../server/utils/state', () => ({
  READY: new Set(['idle', 'done']),
  findPane: () => calls.pane,
  poll: () => {},
  transcripts: { model: async () => calls.model },
}))
vi.mock('../server/utils/quotas', () => ({
  runLocal: async () => {
    calls.listRuns++
    return { code: 0, stdout: Buffer.from(calls.listOut), stderr: '' }
  },
}))
vi.mock('../server/utils/herdr', () => ({
  HerdrError: class HerdrError extends Error {
    constructor(public code: string, message: string) { super(message) }
  },
  sleep: async () => {},
  herdr: async () => ({}),
  agentPrompt: async (_target: string, text: string) => { calls.sent.push({ method: 'agent.prompt', params: { text } }) },
}))

import { listModels, parseCmdModels, setModel } from '../server/utils/modelctl'

beforeEach(() => {
  calls.sent = []
  calls.pane = { id: 'w1:p1', agent: 'cmd', status: 'done' }
  calls.model = null
  calls.listRuns = 0
  calls.listOut = SAMPLE
})

describe('parseCmdModels', () => {
  it('reads the ids and hints, skips the header, sections, footer and decision models', () => {
    const options = parseCmdModels(SAMPLE, 'z-ai/glm-5.3-flash')
    expect(options.map(o => o.label)).toEqual([
      'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash', 'google/gemini-3.8-flash',
    ])
    expect(options[1]!.hint).toBe('fast hybrid-attention reasoning')
    expect(options[1]!.isDefault).toBe(true)
    expect(options[0]!.isDefault).toBe(false)
    expect(options.find(o => o.label === 'z-ai/glm-5.3-flash')!.current).toBe(true)
    expect(options.find(o => o.label === 'typesafe/jev')).toBeUndefined()
  })
})

describe('cmd listModels', () => {
  it('runs the CLI once and caches the list per machine', async () => {
    const list = await listModels('w1:p1')
    expect(list.agent).toBe('cmd')
    expect(list.options.length).toBe(4)
    expect(list.options[1]!.label).toBe('deepseek/deepseek-v4-flash')
    expect(calls.listRuns).toBe(1)
    await listModels('w1:p1')
    expect(calls.listRuns).toBe(1)
    await listModels('w1:p1', true)
    expect(calls.listRuns).toBe(2)
  })
})

describe('cmd setModel', () => {
  it('types the one-shot command and verifies the model_change in the transcript', async () => {
    calls.model = { id: 'deepseek/deepseek-v4-flash', label: 'deepseek/deepseek-v4-flash', at: new Date(Date.now() - 60000).toISOString() }
    const p = setModel('w1:p1', 'z-ai/glm-5.3-flash')
    calls.model = { id: 'z-ai/glm-5.3-flash', label: 'z-ai/glm-5.3-flash', at: new Date().toISOString() }
    const info = await p
    expect(info.id).toBe('z-ai/glm-5.3-flash')
    // The one-shot command is all it takes: no menu keys are ever sent.
    expect(calls.sent.map(c => c.method)).toEqual(['agent.prompt'])
    expect(calls.sent[0]!.params.text).toBe('/model z-ai/glm-5.3-flash')
  })

  it('does nothing when the session already runs the model', async () => {
    calls.model = { id: 'z-ai/glm-5.3-flash', label: 'z-ai/glm-5.3-flash', at: new Date().toISOString() }
    const info = await setModel('w1:p1', 'z-ai/glm-5.3-flash')
    expect(info.id).toBe('z-ai/glm-5.3-flash')
    expect(calls.sent).toEqual([])
  })

  it('refuses for a blocked pane and for a switch that never lands', async () => {
    calls.pane.status = 'blocked'
    await expect(setModel('w1:p1', 'z-ai/glm-5.3-flash')).rejects.toMatchObject({ code: 'busy' })
    expect(calls.sent).toEqual([])
    calls.pane.status = 'done'
    calls.model = { id: 'deepseek/deepseek-v4-flash', label: 'deepseek/deepseek-v4-flash', at: new Date().toISOString() }
    await expect(setModel('w1:p1', 'z-ai/glm-5.3-flash')).rejects.toMatchObject({ code: 'stale' })
  })
})
