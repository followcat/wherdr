// Agent state on herdr-core: core's documents read into a HerdrState, enriched
// (on-screen questions, previews) and broadcast on every change. One
// events.subscribe connection drives the polls (see startCoreEvents).
import fs from 'node:fs'
import path from 'node:path'
import type { ChatItem, ChatResponse, HerdrState, Pane } from '../../shared/types'
import { coordinatorTarget, type NotificationEvent } from '../../shared/notificationRules'
import { readCoreState, staleCoreDocs, useCoreSession } from './readCoreState'
import { CoreSession } from './coreSession'
import { type CoreAlertKind, createCoreAlerts } from './coreAlerts'
import { notificationAllowed } from './notificationRules'
import { DATA_DIR, HOME, NOTIFY_SETTLE_MS, POLL_MS, log } from './env'
import { sleep } from './herdr'
import { takeBackInterrupted } from './interruptRestore'
import { uploadNames } from '../../shared/queuedMatch'
import { startingState } from '../../shared/stateReady'
import { type TranscriptPane } from './transcripts'
import { type CoreTranscripts, createCoreTranscripts } from './coreTranscripts'
import { coreCall } from './core'
import { createCorePreviews } from './corePreview'
import { agentNotificationTitle, pushSend } from './push'
import { machineOfPane } from './machines'
import { createCodexStatus, dirWritable } from './codexStatus'
import { runLocal, setCodexKnownWeek } from './quotas'
import { pmStore } from './pmStore'
import { projectCoordinatorName } from '../../shared/pm/project'
import { createHeld } from './coreHeld'
import { coreInputDeps, coreSend } from './coreInput'

const fsp = fs.promises
const hcCall = <T>(method: string, params: object, timeout: number) => coreCall<T>(process.env.HC_SOCKET || '', method, params, timeout)

// Transcripts: the agent's process and start come from core, a remote
// machine's disk through its exec.
let coreTr: CoreTranscripts | null = null
function coreTranscriptsOf(): CoreTranscripts {
  return coreTr ||= createCoreTranscripts({ call: hcCall, pane: findPane, localHome: HOME })
}
let coreSubtitles: ReturnType<typeof createCorePreviews> | null = null
const corePreviews = () => coreSubtitles ||= createCorePreviews({
  reply: p => coreTranscriptsOf().latestReply(p),
  read: async address => (await hcCall<{ text?: string }>('terminal.read', { terminal: address }, 4000)).text || '',
  wake: () => scheduleCorePoll(),
})
export const transcripts = {
  chat: (p: TranscriptPane, o: Parameters<CoreTranscripts['chat']>[1] = {}) => coreTranscriptsOf().chat(p, o),
  preview: (p: TranscriptPane) => coreTranscriptsOf().preview(p),
  image: (p: TranscriptPane, file: string | null, ref: string | null, i: number) => coreTranscriptsOf().image(p, file, ref, i),
  model: (p: TranscriptPane) => coreTranscriptsOf().model(p),
  locate: (p: TranscriptPane) => coreTranscriptsOf().locate(p),
  pendingTool: (p: TranscriptPane, tool?: string | null) => coreTranscriptsOf().pendingTool(p, tool),
  pendingAsk: (p: TranscriptPane) => coreTranscriptsOf().pendingAsk(p),
  pendingClaudeQuestions: (p: TranscriptPane) => coreTranscriptsOf().pendingClaudeQuestions(p),
  search: (p: TranscriptPane, query: string, deadline: number) => coreTranscriptsOf().search(p, query, deadline),
  current: (p: TranscriptPane, r: ChatResponse) => coreTranscriptsOf().current(p, r),
  live: (p: TranscriptPane, r: ChatResponse) => coreTranscriptsOf().live(p, r),
  forget: (id: string) => coreTranscriptsOf().forget(id),
}

// ---------------------------------------------------------------- clients
// What each device is looking at (no notification for the agent shown on screen),
// its kind and when the user last used it (`ui open` goes to that one).
export interface EventClient { send: (data: string) => void, pane: string | null, visible: boolean, device?: 'phone' | 'computer', activeAt?: number }
export const eventClients = new Map<string, EventClient>()

let state: HerdrState = startingState()
let stateJson = JSON.stringify(state)
export const getStateJson = () => stateJson
export const getState = () => state
export const findPane = (id: string | null | undefined) => state.panes.find(p => p.id === id)

function broadcastState() {
  for (const c of eventClients.values()) {
    try { c.send(stateJson) }
    catch { /* client gone */ }
  }
}

// The server is stopping (a restart for an update): open pages keep what they
// show until it is back, instead of switching to their offline look.
export function announceRestart() {
  const msg = JSON.stringify({ type: 'restarting' })
  for (const c of eventClients.values()) {
    try { c.send(msg) }
    catch { /* client gone */ }
  }
}

export function isViewed(paneId: string) {
  for (const v of eventClients.values()) if (v.pane === paneId && v.visible) return true
  return false
}

// ---------------------------------------------------------------- Codex weekly window
// Latest Codex weekly window per machine, kept across restarts (quotas.ts).
const CODEX_WEEK_FILE = path.join(DATA_DIR, 'codex-week.json')
let codexWeekWrite: Promise<unknown> = Promise.resolve()
const codexStatus = createCodexStatus({
  machineOf: (id) => {
    const m = machineOfPane(id)
    if (!m || !m.home) return null
    const exec = m.exec
    return {
      key: m.info().baseKey || m.key, label: m.label, local: m.local, home: m.home, fs: m.fs,
      online: m.local || m.status === 'online',
      exec: exec ? (script, input, timeoutMs) => exec(script, [], { input, timeoutMs }) : null,
    }
  },
  // Codex screens are not read on core: the weekly window comes from its conversation.
  readScreen: () => Promise.reject(new Error('no screen on core')),
  rolloutOf: async p => (await transcripts.locate(p))?.file || null,
  agentPid: async () => null,
  runLocal,
  writable: dirWritable,
  onChange: () => { void poll() },
  log,
  loadWeeks: () => {
    try { return JSON.parse(fs.readFileSync(CODEX_WEEK_FILE, 'utf8')) } catch { return null }
  },
  saveWeeks: (weeks) => {
    const text = JSON.stringify(weeks) + '\n'
    // One write at a time, in order: the last one wins.
    codexWeekWrite = codexWeekWrite
      .then(() => fsp.mkdir(DATA_DIR, { recursive: true }))
      .then(() => fsp.writeFile(CODEX_WEEK_FILE, text, { mode: 0o600 }))
      .catch(() => {})
  },
})
setCodexKnownWeek((key, rolled) => codexStatus.knownWeek(key, state.panes, rolled))

// ---------------------------------------------------------------- taken back
// Messages taken back after a Stop (see interruptRestore.ts): hidden from the
// conversation, by text and time, until Claude's transcript drops them itself
// (next message written as their sibling).
const takenBack = new Map<string, { text: string, ts: string | null }[]>()
let takenBackSeq = 0
export const takenBackOf = (paneId: string) => ({ hidden: takenBack.get(paneId) || [], seq: takenBackSeq })
export function takeBack(paneId: string, item: { text: string, ts?: string | null, images?: number }): { text: string, lost: number } {
  takenBackSeq++
  takenBack.set(paneId, [...takenBackOf(paneId).hidden, { text: item.text, ts: item.ts || null }].slice(-20))
  setTimeout(poll, 50)
  // Photos Claude does not give back with the text are lost (it keeps no copy of them).
  return { text: item.text, lost: Math.max(0, (item.images || 0) - uploadNames(item.text).length) }
}

// After an interrupt: the prompt Claude put back into its field, taken out of
// it (see interruptRestore.ts). The transcript is looked for again: a brand new
// Claude's first message may be the only thing in it, and only just written.
export function takeBackFromClaude(p: Pane, io: { screen: () => Promise<string>, keys: (keys: string[]) => Promise<void> }): Promise<ChatItem | null> {
  return takeBackInterrupted({
    screen: io.screen,
    keys: io.keys,
    chat: async () => (await transcripts.chat(p, { fresh: true })).items || [],
    sleep,
    pending: () => [],
  }).catch(() => null)
}

// ---------------------------------------------------------------- held messages
// Sent while Codex installs or updates itself: typed once it is ready (coreHeld.ts).
export const heldMessages = createHeld((p, q) => coreSend(coreInputDeps(), { pane_id: p.id, text: q.text }))

// ---------------------------------------------------------------- poll
export async function poll() {
  lastCorePoll = Date.now()
  state = await readCoreState(state)
  heldMessages.apply(state.panes)
  await coreScreens().enrich(state.panes).catch(() => {})
  void coreTranscriptsOf().observe(state.panes)
  corePreviews().apply(state.panes)
  const json = JSON.stringify(state)
  if (json !== stateJson) { stateJson = json; broadcastState() }
}

// ---------------------------------------------------------------- core events
// One events.subscribe connection instead of a poll every second. State is
// rebuilt (debounced) on each change; machines are read again every few seconds, and the
// poll comes back to POLL_MS while the connection is down.
let pollTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false
let lastCorePoll = 0
let coreSession: CoreSession | null = null
let coreAlerts: ReturnType<typeof createCoreAlerts> | null = null
// Core events come in bursts (a streaming agent, a resize): each poll is still
// debounced by `debounceMs`, and two event polls start at least `gapMs` apart,
// so a burst does not broadcast the whole state many times a second. One poll
// at a time; an event during a poll asks for another one after it.
export function corePollGate(run: () => Promise<void>, { debounceMs = 50, gapMs = 400, now = Date.now, active = (): boolean => true }: { debounceMs?: number, gapMs?: number, now?: () => number, active?: () => boolean } = {}) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let busy = false
  let again = false
  let last = -Infinity
  function schedule() {
    if (timer || !active()) return
    if (busy) { again = true; return }
    timer = setTimeout(async () => {
      timer = null
      if (busy) { again = true; return }
      busy = true
      last = now()
      try { await run() } finally {
        busy = false
        if (again) { again = false; schedule() }
      }
    }, Math.max(debounceMs, last + gapMs - now()))
  }
  function cancel() {
    if (timer) clearTimeout(timer)
    timer = null
    again = false
  }
  return { schedule, cancel }
}
const corePolls = corePollGate(() => poll(), { active: () => !stopped })
const scheduleCorePoll = corePolls.schedule

export function startPolling() {
  stopped = false
  const endpoint = process.env.HC_SOCKET
  if (endpoint) {
    coreAlerts = createCoreAlerts({ settleMs: NOTIFY_SETTLE_MS, current: a => coreSession?.get(a), send: (a, k) => { notifyCorePane(a, k).catch(e => log('notification:', e.message)) } })
    coreSession = new CoreSession({ endpoint,
      onEvent: (e, before, after) => coreAlerts?.onEvent(e, before, after),
      onChange: (what) => { if (what !== 'terminal') staleCoreDocs(); scheduleCorePoll() },
      onStatus: scheduleCorePoll })
    useCoreSession(coreSession)
    coreSession.start()
  }
  const loop = async () => {
    if (!coreSession?.connected || Date.now() - lastCorePoll > 5000) await poll()
    if (!stopped) pollTimer = setTimeout(loop, coreSession?.connected ? 5000 : POLL_MS)
  }
  void loop()
}

export function stopPolling() {
  stopped = true
  coreSession?.stop()
  coreAlerts?.stop()
  coreSession = null
  coreAlerts = null
  useCoreSession(null)
  corePolls.cancel()
  if (pollTimer) clearTimeout(pollTimer)
}

// ---------------------------------------------------------------- notifications
const AGENT_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', cursor: 'Cursor' }
const agentLabel = (k: string | null) => (k && AGENT_LABEL[k]) || (k ? k[0]!.toUpperCase() + k.slice(1) : 'Agent')
const notificationTitle = (title: string | null) => (title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim()

const isTaskAgent = async (address: string) => {
  try { const pm = pmStore(); return (await pm.enabled()) && (await pm.runs()).some(r => r.terminal === address && r.state !== 'ended') }
  catch { return false }
}

// Alfred's or a project coordinator's terminal: its coordinator exception
// decides, and its push names it (Alfred's name, else the coordinator's: projectCoordinatorName).
const coordinatorAt = async (address: string) => {
  try {
    const store = pmStore(), c = (await store.coordinators()).find(x => x.terminal === address)
    if (!c) return undefined
    const p = (await store.projects()).find(x => x.key === c.project)
    const name = p ? projectCoordinatorName(p) : (await (await import('./pmCoordinator')).alfredView({ store })).name
    return { target: coordinatorTarget(c.project), name }
  } catch { return undefined }
}

async function notifyCorePane(address: string, kind: CoreAlertKind) {
  const p = state.panes.find(x => x.coreAddress === address)
  if (!p || isViewed(p.id)) return
  // A project task's agent waiting for the user goes into the grouped Decisions push.
  if (kind === 'needs-you' && await isTaskAgent(address)) return
  const event: NotificationEvent = kind === 'needs-you' ? 'needs-you' : 'finished'
  const coordinator = await coordinatorAt(address)
  if (!await notificationAllowed(event, state, p, { machine: p.machine ?? '', ...(coordinator ? { coordinator: coordinator.target } : {}) })) return
  const ws = state.workspaces.find(w => w.id === p.workspace)
  const where = [ws && ws.label, notificationTitle(p.title)].filter(Boolean).join(' · ')
  const on = state.machines && state.machines.length > 1 && p.machine ? `${state.machines.find(m => m.key === p.machine)?.label ?? p.machine} · ` : ''
  const { title, titleFr } = agentNotificationTitle(kind === 'needs-you' ? 'blocked' : 'done', `${on}${coordinator?.name || agentLabel(p.agent)}`)
  const badge = state.panes.filter(x => x.status === 'blocked' || x.status === 'done').length
  const sent = await pushSend({ title, titleFr, body: where || p.id, tag: `pane-${p.id}`, url: `/#/a/${encodeURIComponent(p.id)}`, badge })
  log(`notification ${p.id} ${kind} "${title}" -> ${sent} device(s)`)
}
