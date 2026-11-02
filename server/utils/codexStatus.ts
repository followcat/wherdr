// Codex notices of a conversation on screen (see shared/codexStatus.ts):
// "Update available" with an Update button, and the weekly-limit warning
// (only while Codex's screen shows one, with its values: codexWeeklyWarning).
// Read in the background for a Codex shown on a device, at most every
// STATUS_MS; Codex's own files are re-read at most every FILES_MS per machine.
// The update runs Codex's known official command on the agent's machine
// (`sh -s` over SSH, or locally when its home is writable), otherwise at the
// shell prompt of the agent's pane once Codex has quit (codexTermUpdate.ts);
// never text typed into the Codex TUI nor a command read from the screen.
// The weekly reading of the screens (`/status`) feeds the home gauge
// (knownWeek, server/utils/quotas.ts): every Codex pane of the machine is
// read for it, at most every SCREEN_MS, shown on a device or not. With the
// machine's newest conversation reading, it updates the latest window known
// for the machine (rememberWeek), saved through `saveWeeks` (data/), so that
// a `/status` read before Codex or wherdr restarts still makes the older
// window stale for the gauge.
import fs from 'node:fs'
import path from 'node:path'
import type { Pane } from '../../shared/types'
import {
  type CodexScreenInfo, type CodexScreenWeekly, type CodexStatus, type CodexUpdateJob, type CodexWeekly, type KnownWeek,
  type WeekReading, codexUpdateState, codexWeeklyWarning, loadKnownWeeks, parseCliVersion, parseCodexScreen, parsePackageVersion,
  parseVersionFile, rememberWeek, rolloutCliVersion, runningVersion, tuiVersion, updateScript, weekFromReading, weekFromScreen,
} from '../../shared/codexStatus'
import type { ExecResult, MachineFs } from './fsx'
import { HerdrError } from './herdr'

const STATUS_MS = 10000
const FILES_MS = 60000
const SCREEN_MS = 30000
// Codex panes read per machine for the home gauge.
const SCREEN_MAX = 8
const UPDATE_TIMEOUT_MS = 5 * 60000
// A finished update stays known this long (installed version, failure shown).
const JOB_TTL_MS = 6 * 3600000

export interface CodexMachine {
  key: string
  label: string
  local: boolean
  home: string
  fs: MachineFs
  online: boolean
  exec: ((script: string, input: Buffer, timeoutMs: number) => Promise<ExecResult>) | null
}

export interface CodexStatusDeps {
  machineOf: (paneId: string) => CodexMachine | null
  readScreen: (paneId: string) => Promise<string>
  rolloutOf: (p: Pane) => Promise<string | null>
  // Pid of the Codex process in the pane (null: none or unknown). A version
  // read on its screen is remembered only for that same process.
  agentPid?: (paneId: string) => Promise<number | null>
  runLocal: (script: string, home: string, timeoutMs: number) => Promise<ExecResult>
  writable: (dir: string) => Promise<boolean>
  onChange: () => void
  log: (msg: string) => void
  now?: () => number
  // Known weekly windows per machine key, read once at start and saved on change.
  loadWeeks?: () => unknown
  saveWeeks?: (weeks: Record<string, KnownWeek>) => void
}

interface MachineFiles { latest: string | null, dismissed: string | null, installed: string | null, standalone: boolean, canRun: boolean, at: number }
interface RolloutInfo { size: number, version: string | null }
type Job = CodexUpdateJob & { started: number }

export function createCodexStatus(d: CodexStatusDeps) {
  const now = d.now ?? Date.now
  const statuses = new Map<string, { status: CodexStatus | null, at: number }>()
  const busy = new Set<string>()
  const files = new Map<string, MachineFiles>()
  // Last decision logged per pane (logged again only when it changes).
  const why = new Map<string, string>()
  const rollouts = new Map<string, RolloutInfo>()
  const jobs = new Map<string, Job>()
  // Version last read on each Codex screen (pane id), with the pid of the
  // process that showed it: the header scrolls away, the process stays.
  const seenTui = new Map<string, { pid: number, version: string }>()
  // Weekly-limit warning last read on each Codex screen (pane id).
  const warnings = new Map<string, CodexWeekly | null>()
  // Last weekly reading on each Codex screen (pane id), for the home gauge.
  const screens = new Map<string, { key: string, weekly?: CodexScreenWeekly, at: number }>()
  // Latest weekly window known per machine key (see rememberWeek).
  const weeks = new Map<string, KnownWeek>(loadKnownWeeks(d.loadWeeks?.(), now()))

  function note(key: string, ...readings: (KnownWeek | null)[]): KnownWeek | null {
    const old = weeks.get(key) ?? null
    let k = old
    for (const r of readings) k = rememberWeek(k, r, now())
    if (k) weeks.set(key, k)
    else weeks.delete(key)
    if (JSON.stringify(k) !== JSON.stringify(old)) {
      const t = now()
      for (const [id, w] of weeks) if (w.resetsAt <= t) weeks.delete(id)
      d.saveWeeks?.(Object.fromEntries(weeks))
    }
    return k
  }

  async function machineFiles(m: CodexMachine): Promise<MachineFiles> {
    const old = files.get(m.key)
    if (old && now() - old.at < FILES_MS) return old
    const codex = path.posix.join(m.home, '.codex')
    const read = (f: string) => m.fs.readFile(path.posix.join(codex, f)).catch(() => null)
    const pkgFile = 'packages/standalone/current/codex-package.json'
    const [vf, pkg] = await Promise.all([read('version.json'), read(pkgFile)])
    const { latest, dismissed } = parseVersionFile(vf)
    const installed = parsePackageVersion(pkg)
    const canRun = m.local ? await d.writable(codex) : Boolean(m.exec && m.online)
    const f = { latest, dismissed, installed, standalone: Boolean(installed), canRun, at: now() }
    files.set(m.key, f)
    return f
  }

  // `cli_version` in the header of the agent's rollout (read once per size).
  async function rolloutInfo(m: CodexMachine, file: string | null): Promise<RolloutInfo | null> {
    if (!file) return null
    let size = 0
    try { size = (await m.fs.stat(file)).size }
    catch { return null }
    const old = rollouts.get(file)
    if (old && (old.size === size || old.version)) return old
    let version: string | null = null
    for (const max of [64 * 1024, 512 * 1024]) {
      const len = Math.min(size, max)
      const head = (await m.fs.read(file, 0, len).catch(() => Buffer.alloc(0))).toString('utf8')
      if (head.includes('\n') || len === size) { version = rolloutCliVersion(head); break }
    }
    const info = { size, version }
    rollouts.set(file, info)
    return info
  }

  function jobOf(key: string): Job | null {
    const j = jobs.get(key)
    if (j && j.phase !== 'running' && now() - j.started > JOB_TTL_MS) { jobs.delete(key); return null }
    return j || null
  }
  const publicJob = (j: Job | null): CodexUpdateJob | null => {
    if (!j) return null
    const { started: _, ...pub } = j
    return pub as CodexUpdateJob
  }

  async function compute(p: Pane): Promise<CodexStatus | null> {
    const m = d.machineOf(p.id)
    if (!m) return null
    let screenError: string | null = null
    const [mf, screenText, file, pid] = await Promise.all([
      machineFiles(m),
      d.readScreen(p.id).catch((e: Error) => { screenError = e.message || 'error'; return '' }),
      d.rolloutOf(p).catch(() => null),
      d.agentPid ? d.agentPid(p.id).catch(() => null) : Promise.resolve(null),
    ])
    const screen: CodexScreenInfo = parseCodexScreen(screenText)
    // Remembered only while the same process runs: unknown pid, nothing kept.
    const kept = seenTui.get(p.id)
    const seen = pid && kept?.pid === pid ? kept.version : null
    const tui = tuiVersion(screen, seen)
    if (pid && tui) seenTui.set(p.id, { pid, version: tui })
    else if (!pid || kept?.pid !== pid) seenTui.delete(p.id)
    if (!screenError) screens.set(p.id, { key: m.key, weekly: screen.weekly, at: now() })
    const ro = await rolloutInfo(m, file)
    const job = publicJob(jobOf(m.key))
    const running = runningVersion({ rollout: ro?.version ?? null, screen, seen })
    const update = codexUpdateState({ running, tui, latest: mf.latest, dismissed: mf.dismissed, installed: mf.installed, standalone: mf.standalone, screen, canRun: mf.canRun, job })
    // An unreadable screen keeps the warning it last showed.
    const weekly = screenError ? (warnings.get(p.id) ?? null) : codexWeeklyWarning(screenText)
    if (!screenError) warnings.set(p.id, weekly)
    const line = [
      `running=${running ?? '?'} (screen ${screenError ? `unreadable: ${screenError}` : screen.version ?? screen.update?.current ?? '-'}${seen ? `, seen ${seen}` : ''}, rollout ${ro?.version ?? '-'})`,
      `installed=${mf.installed ?? '-'} latest=${mf.latest ?? '-'}${mf.dismissed ? ` dismissed=${mf.dismissed}` : ''}`,
      `-> ${update ? update.state : 'no update'}`,
      `-> ${weekly ? `weekly warning on screen: ${weekly.lessThan ? '< ' : ''}${weekly.left}%` : 'no weekly warning on screen'}`,
    ].join(' ')
    if (why.get(p.id) !== line) { why.set(p.id, line); d.log(`codex status ${p.id}: ${line}`) }
    const out: CodexStatus = {}
    if (update) out.update = update
    if (weekly) out.weekly = weekly
    return out.update || out.weekly ? out : null
  }

  function refresh(p: Pane) {
    if (busy.has(p.id)) return
    busy.add(p.id)
    compute(p)
      .catch(() => statuses.get(p.id)?.status ?? null)
      .then((status) => {
        const old = statuses.get(p.id)?.status ?? null
        statuses.set(p.id, { status, at: now() })
        if (JSON.stringify(old) !== JSON.stringify(status)) setTimeout(d.onChange, 0)
      })
      .finally(() => busy.delete(p.id))
  }

  // Status of a Codex on screen (refreshed in the background).
  // The machine's update job is applied right away (no wait for the re-read).
  function statusOf(p: Pane): CodexStatus | null {
    const s = statuses.get(p.id)
    if (!s || now() - s.at >= STATUS_MS) refresh(p)
    const st = s?.status ?? null
    const m = d.machineOf(p.id)
    const job = m ? publicJob(jobOf(m.key)) : null
    if (!job || !st?.update || job.phase === 'done') return st
    return { ...st, update: { ...st.update, job } }
  }
  const stale = (key: string | null) => {
    for (const [id, s] of statuses) if (key === null || d.machineOf(id)?.key === key) s.at = 0
  }

  function forget(paneId: string) { statuses.delete(paneId); why.delete(paneId); warnings.delete(paneId); seenTui.delete(paneId) }

  // Runs the update on the agent's machine; returns right away, the progress
  // goes through `codexStatus.update.job` of the machine's Codex panes.
  // Method `terminal`: `inPane` types it into the agent's pane (restart.ts),
  // its progress shows in that pane's `restart`.
  async function startUpdate(p: Pane, inPane?: (command: string) => Promise<{ done: Promise<void> }>) {
    const m = d.machineOf(p.id)
    if (!m) throw new HerdrError('bad_pane', 'agent not found')
    if (jobOf(m.key)?.phase === 'running') throw new HerdrError('update_busy', 'Codex update already in progress')
    files.delete(m.key) // fresh versions and rights
    const st = await compute(p)
    const u = st?.update
    if (!u || u.state !== 'available' || !u.command) throw new HerdrError('update_unavailable', 'No Codex update to install')
    if (!u.runnable || !u.method || (u.method === 'terminal' && !inPane)) throw new HerdrError('update_manual', 'This update cannot be run from wherdr: copy the command')
    if (u.method === 'terminal') {
      const { done } = await inPane!(u.command)
      jobs.set(m.key, { phase: 'running', pane: p.id, started: now() })
      d.onChange()
      done.then(() => {
        // The installed version: on screen once Codex is back (its header).
        jobs.set(m.key, { phase: 'done', version: null, at: now(), started: now() })
      }, () => {
        // The error is shown in the pane, left at its shell.
        jobs.delete(m.key)
      }).finally(() => {
        files.delete(m.key)
        stale(m.key)
        d.onChange()
      })
      return { command: u.command, method: u.method }
    }
    const script = updateScript(u.command)
    jobs.set(m.key, { phase: 'running', started: now() })
    d.onChange()
    d.log(`codex update on ${m.label || m.key}: ${u.command}`)
    void (async () => {
      let job: Job
      try {
        const r = m.local ? await d.runLocal(script, m.home, UPDATE_TIMEOUT_MS) : await m.exec!('exec sh -s', Buffer.from(script), UPDATE_TIMEOUT_MS)
        const out = r.stdout.toString('utf8')
        if (r.code !== 0) {
          const last = (r.stderr.trim().split('\n').filter(Boolean).pop() || out.trim().split('\n').pop() || `code ${r.code}`).slice(0, 300)
          job = { phase: 'failed', error: last, started: now() }
        } else {
          const lines = out.trim().split('\n')
          job = { phase: 'done', version: parseCliVersion(lines[lines.length - 1]), at: now(), started: now() }
        }
      } catch (e) { job = { phase: 'failed', error: (e as Error).message, started: now() } }
      jobs.set(m.key, job)
      files.delete(m.key)
      stale(m.key)
      d.log(`codex update on ${m.label || m.key}: ${job.phase}${job.phase === 'failed' ? ` (${job.error})` : ''}`)
      d.onChange()
    })()
    return { command: u.command, method: u.method }
  }

  // Hides a failed update.
  function dismiss(p: Pane) {
    const m = d.machineOf(p.id)
    if (m && jobOf(m.key)?.phase === 'failed') jobs.delete(m.key)
    stale(m ? m.key : null)
    d.onChange()
  }

  // Latest weekly window known for a machine (key), after reading its Codex
  // screens among `panes` (all the panes known: those of other machines and
  // other agents are skipped; screens not read for SCREEN_MS are read again)
  // and `rolled`, the machine's newest conversation reading.
  async function knownWeek(key: string, panes: Pane[], rolled: WeekReading | null = null): Promise<KnownWeek | null> {
    const mine = panes.filter(p => p.agent === 'codex' && d.machineOf(p.id)?.key === key).slice(0, SCREEN_MAX)
    const ids = new Set(mine.map(p => p.id))
    for (const [id, s] of screens) if (s.key === key && !ids.has(id)) screens.delete(id)
    await Promise.all(mine.map(async (p) => {
      const old = screens.get(p.id)
      if (old && now() - old.at < SCREEN_MS) return
      try { screens.set(p.id, { key, weekly: parseCodexScreen(await d.readScreen(p.id)).weekly, at: now() }) }
      catch { /* unreadable: keep the previous reading */ }
    }))
    const account = rolled?.account ?? null
    const seen = [...screens.values()].filter(s => s.key === key).map(s => weekFromScreen(s.weekly, now(), account))
    return note(key, weekFromReading(rolled), ...seen)
  }

  return { statusOf, forget, startUpdate, dismiss, compute, knownWeek }
}

export type CodexStatusService = ReturnType<typeof createCodexStatus>

export async function dirWritable(dir: string): Promise<boolean> {
  try {
    await fs.promises.access(dir, fs.constants.W_OK)
    return true
  } catch { return false }
}
