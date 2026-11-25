// Agent state on herdr-core: core's documents read into a HerdrState, enriched
// (on-screen questions, previews) and broadcast on every change. One
// events.subscribe connection drives the polls (see startCoreEvents).
import fs from 'node:fs'
import path from 'node:path'
import type { ChatItem, ChatResponse, HerdrState, ModelInfo, Pane } from '../../shared/types'
import { coordinatorTarget, type NotificationEvent } from '../../shared/notificationRules'
import { hasTranscript } from '../../shared/agentKind'
import { type CoreAlertKind } from './coreAlerts'
import { createCorePool, registerPoolRuntime, resolveConfiguredSockets, type CoreEntry } from './corePool'
import { filterAllowedHcSockets, hcSockets, onSettingsChange } from './settings'
import { notificationAllowed } from './notificationRules'
import { DATA_DIR, HOME, NOTIFY_SETTLE_MS, POLL_MS, log } from './env'
import { HerdrError, sleep } from './herdr'
import { takeBackInterrupted } from './interruptRestore'
import { uploadNames } from '../../shared/queuedMatch'
import { startingState } from '../../shared/stateReady'
import { type TranscriptPane } from './transcripts'
import { type CoreTranscripts, createCoreTranscripts } from './coreTranscripts'
import { createCodexDaemonHistory } from './codexDaemon'
import { createCodexDaemonRpc } from './codexDaemonRpc'
import { createCorePreviews } from './corePreview'
import { coreScreens } from './coreScreenDeps'
import { agentNotificationTitle, pushSend } from './push'
import { localMachine, localMachineLabel, machineOfPane } from './machines'
import { createCodexStatus, dirWritable } from './codexStatus'
import { runLocal, setCodexKnownWeek } from './quotas'
import { pmStore } from './pmStore'
import { projectCoordinatorName } from '../../shared/pm/project'
import { createHeld, heldFile } from './coreHeld'
import { coreInputDeps, coreSend } from './coreInput'
import { devinCards } from './devinCards'
import { createModelCtl, createModelRefresh } from './modelctl'
import { createCoreModelCtl } from './coreModelctl'
import { coreFilesMachine } from './coreFilesMachine'
import { createShellFs } from './fsx'
import { onSubmittingChange } from './submitting'

const fsp = fs.promises
let configuredSettingsSockets: string[] = []
const configuredSockets = () => resolveConfiguredSockets({
  primary: process.env.HC_SOCKET,
  envSockets: process.env.HC_SOCKETS,
  settingsSockets: configuredSettingsSockets,
})

const coreTranscriptsMap = new Map<string, CoreTranscripts>()
const corePreviewsMap = new Map<string, ReturnType<typeof createCorePreviews>>()
const coreModelCtlMap = new Map<string, ReturnType<typeof createCoreModelCtl>>()
const entryPollTimers = new Map<string, { last: number; timer: ReturnType<typeof setTimeout> | null }>()
const entryPollGates = new Map<string, ReturnType<typeof corePollGate>>()

function transcriptsForEntry(entry: CoreEntry): CoreTranscripts {
  let tr = coreTranscriptsMap.get(entry.endpoint)
  if (!tr) {
    tr = createCoreTranscripts({
      call: (method, params, timeout) => entry.call(method, params, timeout),
      pane: findPane,
      localHome: HOME,
      codexHistory: createCodexDaemonHistory({ rpc: createCodexDaemonRpc(process.env.CODEX_HOME || path.join(HOME, '.codex')) }),
    })
    coreTranscriptsMap.set(entry.endpoint, tr)
  }
  return tr
}

function coreTranscriptsOf(paneOrId?: string | { id: string }): CoreTranscripts {
  const entry = paneOrId ? coreForPane(typeof paneOrId === 'string' ? paneOrId : paneOrId.id) : corePool.primary()
  if (!entry) throw new HerdrError('bad_pane', 'Pane not found')
  return transcriptsForEntry(entry)
}

const corePreviewsFor = (entry: CoreEntry) => {
  let previews = corePreviewsMap.get(entry.endpoint)
  if (!previews) {
    previews = createCorePreviews({
      reply: p => transcriptsForEntry(entry).latestReply(p),
      read: async address => (await entry.call<{ text?: string }>('terminal.read', { terminal: address }, 4000)).text || '',
      wake: () => gateForEntry(entry).schedule(),
    })
    corePreviewsMap.set(entry.endpoint, previews)
  }
  return previews
}

export const corePool = createCorePool({
  ...configuredSockets(),
  hostLabel: localMachineLabel,
  settleMs: NOTIFY_SETTLE_MS,
  onAlert: (machineKey, address, kind) => { notifyCorePane(machineKey, address, kind).catch(e => log('notification:', e.message)) },
  onChange: (entry) => { gateForEntry(entry).schedule() },
  onStatus: (entry) => { gateForEntry(entry).schedule() },
})

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

const ensurePoolSynced = () => {
  const cfg = configuredSockets()
  const entries = corePool.entries()
  const currentPrimary = corePool.primary()?.endpoint || ''
  const currentExtra = entries.filter(e => !e.primary).map(e => e.endpoint)
  if (currentPrimary !== cfg.primary || !sameList(currentExtra, cfg.extra)) syncPoolConfig(cfg)
}

function syncPoolConfig(cfg = configuredSockets()) {
  corePool.reconfigure(cfg)
  const active = new Set(corePool.entries().map(e => e.endpoint))
  for (const ep of coreTranscriptsMap.keys()) if (!active.has(ep)) coreTranscriptsMap.delete(ep)
  for (const ep of corePreviewsMap.keys()) if (!active.has(ep)) corePreviewsMap.delete(ep)
  for (const ep of coreModelCtlMap.keys()) if (!active.has(ep)) coreModelCtlMap.delete(ep)
  for (const [ep, gate] of entryPollGates) if (!active.has(ep)) { gate.cancel(); entryPollGates.delete(ep) }
  for (const [ep, t] of entryPollTimers) if (!active.has(ep)) { if (t.timer) clearTimeout(t.timer); entryPollTimers.delete(ep) }
  if (!stopped) {
    for (const e of corePool.entries()) startEntryLoop(e)
  }
}

export const corePrimary = () => { ensurePoolSynced(); return corePool.primary() }
export const coreForPane = (paneId: unknown) => { ensurePoolSynced(); return corePool.forPane(paneId) }
export const coreForMachine = (machineKey: unknown) => { ensurePoolSynced(); return corePool.forMachine(machineKey) }

export const transcripts = {
  chat: (p: TranscriptPane, o: Parameters<CoreTranscripts['chat']>[1] = {}) => coreTranscriptsOf(p).chat(p, o),
  preview: (p: TranscriptPane) => coreTranscriptsOf(p).preview(p),
  image: (p: TranscriptPane, file: string | null, ref: string | null, i: number) => coreTranscriptsOf(p).image(p, file, ref, i),
  model: (p: TranscriptPane) => coreTranscriptsOf(p).model(p),
  opencodeModels: (p: TranscriptPane) => coreTranscriptsOf(p).opencodeModels(p),
  opencodePatchModel: (p: TranscriptPane, model: { id: string, providerID: string, variant?: string }) => coreTranscriptsOf(p).opencodePatchModel(p, model),
  locate: (p: TranscriptPane) => coreTranscriptsOf(p).locate(p),
  pendingTool: (p: TranscriptPane, tool?: string | null) => coreTranscriptsOf(p).pendingTool(p, tool),
  pendingAsk: (p: TranscriptPane) => coreTranscriptsOf(p).pendingAsk(p),
  pendingClaudeQuestions: (p: TranscriptPane) => coreTranscriptsOf(p).pendingClaudeQuestions(p),
  search: (p: TranscriptPane, query: string, deadline: number) => coreTranscriptsOf(p).search(p, query, deadline),
  current: (p: TranscriptPane, r: ChatResponse) => coreTranscriptsOf(p).current(p, r),
  live: (p: TranscriptPane, r: ChatResponse) => coreTranscriptsOf(p).live(p, r),
  forget: (id: string) => { for (const tr of coreTranscriptsMap.values()) tr.forget(id) },
}

// ---------------------------------------------------------------- model pill
// The model shown next to the status (StatusPill): the transcript's, or the
// screen's when it is newer — merge in modelctl.ts, screen reads fed by
// coreScreen's `noted`. The poll below refreshes it; a change re-broadcasts.
let modelCtlInstance: ReturnType<typeof createModelCtl> | null = null
export function modelCtl() {
  return modelCtlInstance ||= createModelCtl({
    transcript: p => transcripts.model(p),
    // ~/.codex/config.toml on the agent's machine (remote: machine.exec fs).
    codexConfig: async (p) => {
      try {
        const m = await coreFilesMachine(p.machine || '')
        const f = m.local || !m.exec ? m.fs : createShellFs(m.exec)
        return await f.readFile(path.posix.join(m.home, '.codex/config.toml'))
      } catch { return null }
    },
    machineKey: p => state.machines?.find(m => m.key === (p.machine || ''))?.baseKey ?? p.machine ?? '',
  })
}
export const currentModel = (p: Pane, historyModel?: ModelInfo | null) => modelCtl().currentModel(p, historyModel)

// The drive side of the picker (coreModelctl): terminal.* through the pane's session call,
// lists cached through modelCtl().noteList (`${machine}|${agent}`).
export function coreModelCtlFor(paneId?: unknown): ReturnType<typeof createCoreModelCtl> | null {
  const entry = paneId ? coreForPane(paneId) : corePrimary()
  if (!entry) return null
  let ctl = coreModelCtlMap.get(entry.endpoint)
  if (!ctl) {
    ctl = createCoreModelCtl({
      call: (method, params, timeout) => entry.call(method, params, timeout),
      pane: id => findPane(id),
      machine: p => coreFilesMachine(p.machine || ''),
      execLocal: (script, home, timeoutMs) => runLocal(script, home, timeoutMs),
      transcript: p => transcripts.model(p),
      currentModel: p => modelCtl().currentModel(p),
      opencodeModels: p => transcripts.opencodeModels(p),
      opencodePatchModel: (p, model) => transcripts.opencodePatchModel(p, model),
      noteList: (p, agent, list) => modelCtl().noteList(p, agent, list),
      noteOverride: (id, info) => modelCtl().noteOverride(id, info),
      noteObservedEffort: (id, label, effort) => modelCtl().noteObservedEffort(id, label, effort),
      noteScreenEffort: (id, effort) => modelCtl().noteScreenEffort(id, effort),
      refresh: () => { setTimeout(() => { void pollEntry(entry) }, 100) },
    })
    coreModelCtlMap.set(entry.endpoint, ctl)
  }
  return ctl
}
export function coreModelCtl(paneId?: unknown) {
  const ctl = coreModelCtlFor(paneId)
  if (!ctl) throw new HerdrError('bad_pane', 'Pane not found')
  return ctl
}
export const modelControlBusy = (paneId: string) => coreModelCtlFor(paneId)?.modelControlBusy(paneId) ?? false
export const noteModelScreen = (p: Pane, text: string) => {
  modelCtl().noteScreen(p.id, p.agent, text)
  coreModelCtlFor(p.id)?.noteRead(p, text)
}

// The poll-side cache of currentModel's answers (dedup, staleness, p.model
// assignment): createModelRefresh in modelctl.ts.
let modelRefreshInstance: ReturnType<typeof createModelRefresh> | null = null
const modelRefresh = () => modelRefreshInstance ||= createModelRefresh({
  currentModel: p => currentModel(p),
  // Change seen outside a poll (choice from the phone): broadcast again.
  changed: () => wakeCorePoll(),
})
export function refreshModel(p: Pane) { modelRefresh().refresh(p) }

// ---------------------------------------------------------------- clients
// What each device is looking at (no notification for the agent shown on screen),
// its kind and when the user last used it (`ui open` goes to that one).
export interface EventClient { send: (data: string) => void, pane: string | null, visible: boolean, device?: 'phone' | 'computer', activeAt?: number }
export const eventClients = new Map<string, EventClient>()

let state: HerdrState = startingState()
let stateJson = JSON.stringify(state)
export const getStateJson = () => stateJson
export const getState = () => state
export const findPane = (id: string | null | undefined) => {
  if (!id) return undefined
  return state.panes.find(p => p.id === id) ?? corePool.findPane(id)
}

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
    const p = findPane(id)
    const info = p ? state.machines?.find(x => x.key === (p.machine ?? '')) : undefined
    if (info?.local) {
      return {
        key: info.baseKey ?? info.key, label: info.label, local: true, home: localMachine.home, fs: localMachine.fs,
        online: info.status === 'online', exec: null,
      }
    }
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
// Sent while Codex installs or updates itself: typed once it is ready (coreHeld.ts),
// kept on disk so that a restart of wherdr resumes them.
export const heldMessages = createHeld((p, q) => coreSend(coreInputDeps(p.id), { pane_id: p.id, text: q.text }), Date.now, heldFile(path.join(DATA_DIR, 'held.json')))

// ---------------------------------------------------------------- poll
async function pollEntry(entry: CoreEntry, publish = true) {
  const tracker = entryPollTimers.get(entry.endpoint)
  if (tracker) tracker.last = Date.now()
  const es = await entry.poll()
  await coreScreens(entry).enrich(es.panes).catch(() => {})
  void transcriptsForEntry(entry).observe(es.panes)
  corePreviewsFor(entry).apply(es.panes)
  const ctl = coreModelCtlMap.get(entry.endpoint)
  for (const p of es.panes) {
    // The model picker's own menu may still be the screen: that mark is not
    // a foreign prompt (ModelPicker's why reads it).
    p.menuLeftOpen = ctl?.menuLeftOpen(p.id) || undefined
    if (!hasTranscript(p.agent)) continue
    modelRefresh().apply(p)
  }
  if (publish) publishMergedState()
}

function publishMergedState() {
  const next = corePool.state()
  if (next.ok !== false) heldMessages.apply(next.panes)
  const alive = new Set(next.panes.map(p => p.id))
  for (const id of modelRefresh().ids()) if (!alive.has(id)) { modelRefresh().forget(id); modelCtl().forgetModel(id) }
  for (const ctl of coreModelCtlMap.values()) ctl.prunePanes(alive)
  devinCards.prune(alive)
  state = next
  const json = JSON.stringify(state)
  if (json !== stateJson) { stateJson = json; broadcastState() }
}

export async function poll() {
  ensurePoolSynced()
  await Promise.allSettled(corePool.entries().map(e => pollEntry(e, true)))
}

// ---------------------------------------------------------------- core events
// One events.subscribe connection per core entry instead of a poll every second.
// State is rebuilt (debounced) per entry on each change; a secondary entry never
// blocks primary or other entries.
let stopped = false
let stopSettingsWatch: (() => void) | null = null
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

function gateForEntry(entry: CoreEntry) {
  let gate = entryPollGates.get(entry.endpoint)
  if (!gate) {
    gate = corePollGate(() => pollEntry(entry), { active: () => !stopped })
    entryPollGates.set(entry.endpoint, gate)
  }
  return gate
}

function startEntryLoop(entry: CoreEntry) {
  if (entryPollTimers.has(entry.endpoint)) return
  const tracker = { last: 0, timer: null as ReturnType<typeof setTimeout> | null }
  entryPollTimers.set(entry.endpoint, tracker)
  const loop = async () => {
    if (!entry.session.connected || Date.now() - tracker.last > 5000) await pollEntry(entry)
    if (!stopped && entryPollTimers.get(entry.endpoint) === tracker) {
      tracker.timer = setTimeout(loop, entry.session.connected ? 5000 : POLL_MS)
    }
  }
  void loop()
}

/** Another poll soon, through the same debounce and gap as core's events. */
export const wakeCorePoll = (paneOrMachine?: string) => {
  ensurePoolSynced()
  if (paneOrMachine) {
    const entry = coreForPane(paneOrMachine) ?? coreForMachine(paneOrMachine)
    if (entry) { gateForEntry(entry).schedule(); return }
  }
  for (const e of corePool.entries()) gateForEntry(e).schedule()
}

export function startPolling() {
  stopped = false
  ensurePoolSynced()
  // A send to Claude starts or ends: its "Sending…" changes on every open page now.
  onSubmittingChange(() => wakeCorePoll())
  stopSettingsWatch?.()
  let hcSocketsGen = 0
  stopSettingsWatch = onSettingsChange((changed) => {
    if ('hcSockets' in changed) {
      const gen = ++hcSocketsGen
      void filterAllowedHcSockets(changed.hcSockets).then((list) => {
        if (stopped || gen !== hcSocketsGen) return
        configuredSettingsSockets = list
        syncPoolConfig()
        void poll()
      }, () => {})
    }
  })
  corePool.start()
  for (const e of corePool.entries()) startEntryLoop(e)
  void hcSockets().then((list) => {
    if (stopped || hcSocketsGen > 0) return
    configuredSettingsSockets = list
    syncPoolConfig()
  }, () => {})
}

export function stopPolling() {
  stopped = true
  stopSettingsWatch?.()
  stopSettingsWatch = null
  corePool.stop()
  for (const gate of entryPollGates.values()) gate.cancel()
  entryPollGates.clear()
  for (const t of entryPollTimers.values()) if (t.timer) clearTimeout(t.timer)
  entryPollTimers.clear()
}

// ---------------------------------------------------------------- notifications
const AGENT_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', cursor: 'Cursor', omp: 'OMP', agy: 'Antigravity' }
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

async function notifyCorePane(machineKey: string, address: string, kind: CoreAlertKind) {
  const p = state.panes.find(x => (x.machine ?? '') === machineKey && x.coreAddress === address)
  if (!p || isViewed(p.id)) return
  if (p.name === 'backlot-stage' || p.name === 'backlot-server' || p.backlotRole === 'stage' || p.backlotRole === 'server') return
  const m = state.machines?.find(x => x.key === machineKey)
  const primary = !m || m.baseKey === undefined
  // A project task's agent waiting for the user goes into the grouped push of what waits for the user (pmDecisions.ts).
  if (kind === 'needs-you' && primary && await isTaskAgent(address)) return
  const event: NotificationEvent = kind === 'needs-you' ? 'needs-you' : 'finished'
  const coordinator = primary ? await coordinatorAt(address) : undefined
  if (!await notificationAllowed(event, state, p, { machine: p.machine ?? '', ...(coordinator ? { coordinator: coordinator.target } : {}) })) return
  const ws = state.workspaces.find(w => w.id === p.workspace)
  const where = [ws && ws.label, notificationTitle(p.title)].filter(Boolean).join(' · ')
  const label = m?.session && m.local ? `${m.label} (${m.session})` : (m?.label ?? p.machine)
  const on = state.machines && state.machines.length > 1 && p.machine ? `${label} · ` : ''
  const { title, titleFr } = agentNotificationTitle(kind === 'needs-you' ? 'blocked' : 'done', `${on}${coordinator?.name || agentLabel(p.agent)}`)
  const badge = state.panes.filter(x => x.status === 'blocked' || x.status === 'done').length
  const sent = await pushSend({ title, titleFr, body: where || p.id, tag: `pane-${p.id}`, url: `/#/a/${encodeURIComponent(p.id)}`, badge })
  log(`notification ${p.id} ${kind} "${title}" -> ${sent} device(s)`)
}

registerPoolRuntime({
  primary: corePrimary,
  forPane: coreForPane,
  forMachine: coreForMachine,
  findPane,
  getState,
  poll,
  wakeCorePoll,
  isViewed,
  noteModelScreen,
  pendingClaudeQuestions: p => transcripts.pendingClaudeQuestions(p),
  takeBack,
  takeBackFromClaude,
})
