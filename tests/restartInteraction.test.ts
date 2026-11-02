// "Restart to update": the agent exits then restarts in the same pane. The
// interactive terminal must neither open nor close during the sequence.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { classifyScreen, type ScreenInteraction } from '../shared/interactiveScreen'
import { createInteractionWindow } from '../app/utils/interactionWindow'
import { ScreenCache } from '../server/utils/screenCache'
import { mapScreenPanes } from '../server/utils/screenGate'
import { bindFunction } from './stateFunction'

const source = readFileSync('server/utils/state.ts', 'utf8')
// Claude after `/exit`, while Herdr still reports it idle.
const EXITING = '❯ /exit\n  ⎿  Goodbye!\n\nResume this session with:\nclaude --resume 00000000-0000-4000-8000-000000000000\nuser@host demo % '

type Restart = { phase: 'stopping' | 'starting' | 'failed', agent: string, at: number, started?: boolean }
// One real poll (state.ts `enrich`) of a pane Herdr reports as `agent`/`status`.
async function poll(restart: Restart | null, agent: string | null, status: string) {
  const map = () => new Map()
  const pane: Record<string, unknown> = { id: 'w1:p1', agent, status, agentSession: 'sid' }
  const restarts = new Map(restart ? [['w1:p1', { ...restart }]] : [])
  const choicesFor = vi.fn(async (p: { agent: string, status: string }) =>
    ({ choices: null, screen: null, menu: null, interaction: classifyScreen({ text: EXITING, agent: p.agent, status: p.status }) }))
  const enrich = bindFunction(source, 'enrich', {
    seenMachines: new Set(['']), mstates: map(), agentBorn: new Map([['w1:p1', { agent, at: null }]]),
    selfUpdates: { prune: () => {}, observe: async () => false }, commands: map(), READY: new Set(),
    getMachine: () => ({ transcripts: { observe: () => {} } }), joinId: (_: string, id: string) => id,
    restarts, leftForGood: () => false, lookForLeftMenu: () => false, findPane: () => null, pendingPrompts: map(), queued: map(),
    screenVersions: new WeakMap(), mapScreenPanes, choicesFor, previews: new Map([['w1:p1', { status, at: Date.now() }]]),
    models: new Map([['w1:p1', { status, at: Date.now() }]]), isViewed: () => false,
    activities: map(), ompStatuses: map(), ocStatuses: map(), ocInboxes: map(), refreshOcStatus: () => {}, codexFields: map(), codexStatus: { forget: () => {} }, devinScreens: map(), refreshDevinScreen: () => {}, chatDelta: { ids: () => [], forget: () => {} },
    choicesCache: new ScreenCache(), askChecks: map(), takenBack: map(), seen: map(),
    saveBorn: () => {}, saveSeen: () => {}, saveQueued: () => {}, machineOf: () => '', paneCommand: () => '',
  })
  await enrich({ panes: [pane] }, { panes: [{ pane_id: 'w1:p1', revision: 1 }] }, '')
  return { interaction: pane.interaction as ScreenInteraction | undefined, read: choicesFor.mock.calls.length > 0 }
}

describe('restart of an agent in its pane', () => {
  it('reads the exit screen of a still-reported agent as a terminal without a restart', async () => {
    expect(await poll(null, 'claude', 'idle')).toEqual({ interaction: 'terminal', read: true })
  })

  it('leaves the pane to the restart, without reading its screen, until it fails', async () => {
    const at = Date.now()
    expect(await poll({ phase: 'stopping', agent: 'claude', at }, 'claude', 'idle')).toEqual({ interaction: 'managed', read: false })
    expect(await poll({ phase: 'starting', agent: 'claude', at }, 'claude', 'idle')).toEqual({ interaction: 'managed', read: false })
    expect(await poll({ phase: 'failed', agent: 'claude', at }, 'claude', 'idle')).toEqual({ interaction: 'terminal', read: true })
  })

  it('never opens the interactive terminal while the agent exits and restarts', async () => {
    const at = Date.now()
    const sequence = [
      await poll(null, 'claude', 'idle').then(() => 'input' as const),
      // Stopping: Herdr still sees Claude for several polls, then the shell alone.
      ...await Promise.all(Array.from({ length: 6 }, () => poll({ phase: 'stopping', agent: 'claude', at }, 'claude', 'idle').then(r => r.interaction))),
      (await poll({ phase: 'stopping', agent: 'claude', at }, null, 'unknown')).interaction,
      (await poll({ phase: 'starting', agent: 'claude', at }, null, 'unknown')).interaction,
      (await poll({ phase: 'starting', agent: 'claude', at, started: true }, 'claude', 'unknown')).interaction,
      'input', 'input', 'input',
    ]
    const w = createInteractionWindow()
    const open = sequence.map((i, n) => w.update(i || 'unknown', n * 400))
    expect(open.some(Boolean)).toBe(false)
  })
})
