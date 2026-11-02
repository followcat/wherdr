import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as choices from '../server/utils/choices'
import * as wait from '../server/utils/waitScreen'
import * as menu from '../shared/menuScreen'
import * as settings from '../shared/settingsScreen'
import { classifyScreen } from '../shared/interactiveScreen'
import { parseUsageLimit } from '../shared/usageLimit'
import { CHOICE_MS, keepReading, ScreenCache } from '../server/utils/screenCache'
import { isPermissionQuestion, mergeDetail } from '../server/utils/promptDetail'
import { opencodeCard } from '../server/utils/opencodePrompts'
import { bindChoices } from './stateFunction'

const source = readFileSync('server/utils/state.ts', 'utf8')
const permission = { id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['npm test'], message: 'Run the tests?' }
const pendingOf = () => ({ permissions: [permission], forms: [] })
const expected = () => opencodeCard(pendingOf())!.choices

describe('readChoices: OpenCode pending permission becomes the native card', () => {
 const pane = { id: 'w1:p1', agent: 'opencode', status: 'blocked' }
 const bind = (opencodePending: unknown) => bindChoices(source, {
  ...choices, ...wait, ...menu, ...settings, classifyScreen, parseUsageLimit, keepReading, isPermissionQuestion, mergeDetail, opencodeCard,
  choicesCache: new ScreenCache(), screenWatch: new Map(), askChecks: new Map(), isViewed: () => true, modelControlBusy: () => false, noteScreen: () => {},
  herdr: vi.fn(async () => ({ read: { text: '┃ Type a message\n╹▀ some footer' } })),
  readMenu: async () => null, withOmpTab: async (_: string, c: unknown) => c,
  transcripts: { pendingAsk: async () => [], pendingClaudeQuestions: async () => [], pendingTool: async () => null, opencodePending },
 })

 it('a pending request is the prompt, whatever the screen shows', async () => {
  const read = bind(async () => pendingOf())
  const r = await read({ ...pane }, 1, false)
  expect(r.interaction).toBe('native')
  expect(r.choices).toEqual(expected())
 })

 it('nothing pending keeps the blocked terminal fallback', async () => {
  const read = bind(async () => ({ permissions: [], forms: [] }))
  const r = await read({ ...pane }, 1, false)
  expect(r.choices).toBeNull()
  expect(r.interaction).toBe('terminal')
 })

 it('a transport failure is not a card', async () => {
  const read = bind(async () => { throw new Error('ssh down') })
  const r = await read({ ...pane }, 1, false)
  expect(r.choices).toBeNull()
  expect(r.interaction).toBe('terminal')
 })

 it('only a blocked pane is asked — an idle one never pays for the shim call', async () => {
  const pending = vi.fn(async () => pendingOf())
  const read = bind(pending)
  const r = await read({ ...pane, status: 'done' }, 1, false)
  expect(pending).not.toHaveBeenCalled()
  expect(r.choices).toBeNull()
 })

 it('a changed request changes the identity', async () => {
  const pending = vi.fn(async () => pendingOf())
  const read = bind(pending)
  const a = (await read({ ...pane }, 1, false)).choices!
  permission.message = 'Deploy now?'
  // New screen revision forces a fresh read: the card reflects the new ask.
  const b = (await read({ ...pane }, 2, false)).choices!
  expect(b.identity).not.toBe(a.identity)
 })
})
