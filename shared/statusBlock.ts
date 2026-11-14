// Live status cards written by an agent in a ```wherdr fenced block, one per
// line: `status machine:<key>`, `status quota:claude|codex`,
// `status pr:<KEY>#<n>`, `status op:<task id>`. The block only names what to
// show: the app reads each one from the APIs it already has (machines'
// memory, quotas, the board), so an agent never writes the state itself.
// A block with any other line is not a status block: it stays code.
import type { Quota, Quotas } from './types'
import { limitState } from './quotaLimit'
import type { MachineCapacity } from './pm/capacity'
import { cardStatus, prLink, type Card } from './pm/board'
import { actionLabel } from './pm/describe'

export type StatusKind = 'machine' | 'quota' | 'pr' | 'op'
export interface StatusRef { kind: StatusKind, arg: string }
export const STATUS_MAX = 8

const LINE = /^status\s+(machine|quota|pr|op):(\S+)$/
const ARG: Record<StatusKind, RegExp> = {
  machine: /^[\w.-]{1,64}$/,
  quota: /^(claude|codex)$/i,
  pr: /^[A-Z][A-Z\d]{0,9}#\d{1,7}$/i,
  op: /^[A-Z][A-Z\d]{0,9}-\d{1,7}$/i,
}

export function parseStatusBlock(text: string): StatusRef[] | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length || lines.length > STATUS_MAX) return null
  const out: StatusRef[] = []
  for (const line of lines) {
    const m = LINE.exec(line)
    if (!m || !ARG[m[1] as StatusKind].test(m[2]!)) return null
    out.push({ kind: m[1] as StatusKind, arg: m[2]! })
  }
  return out
}

// What a card shows. null: its source is gone ("unavailable").
// tone: the dot's colour; bars: quota windows, the share left.
export interface StatusView {
  title: string
  state: string
  tone: 'ok' | 'wait' | 'bad' | 'off'
  lines: string[]
  bars?: { label: string, left: number }[]
  task?: string // the task to open on a tap
}

const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 1 : 0)} GB`
export interface MachineRow { key: string, label: string, mem: MachineCapacity | null, agents: number }
export function machineView(rows: MachineRow[] | null, arg: string): StatusView | null {
  const a = arg.toLowerCase()
  const r = rows?.find(m => m.key.toLowerCase() === a || m.label.toLowerCase() === a)
  if (!r) return null
  const agents = r.agents === 1 ? '1 agent' : `${r.agents} agents`
  if (!r.mem) return { title: r.label, state: 'offline', tone: 'off', lines: [agents] }
  const m = r.mem
  const load = m.cores ? Math.round((m.load1 / m.cores) * 100) : null
  return {
    title: r.label,
    state: 'online',
    tone: m.pressure === 'critical' ? 'bad' : m.pressure === 'warn' ? 'wait' : 'ok',
    lines: [`RAM ${m.pressure ? '≈' : ''}${gb(m.available)} ${m.pressure ? 'available' : 'free'} of ${gb(m.total)}${load === null ? '' : ` · load ${load} %`}`, agents],
  }
}

const left = (w: Quota['five'], now: number) => (!w || (w.resetsAt && w.resetsAt <= now) ? 100 : Math.max(0, Math.round(100 - w.used)))
export function quotaView(q: Quotas | null, arg: string, now: number): StatusView | null {
  const provider = arg.toLowerCase() as 'claude' | 'codex'
  const r = q?.[provider]
  const title = `${provider === 'claude' ? 'Claude' : 'Codex'} quota`
  if (!r) return null
  const limit = limitState(r, now)
  if (limit === 'reached') return { title, state: 'limit reached', tone: 'bad', lines: [] }
  if (limit === 'credits') return { title, state: 'limit reached, on credits', tone: 'wait', lines: [] }
  if (limit === 'expired') return { title, state: 'reset since the last reading', tone: 'ok', lines: [] }
  const bars = [{ label: '5 h', left: left(r.five, now) }, { label: 'week', left: left(r.week, now) }]
  const low = Math.min(...bars.map(b => b.left))
  return { title, state: `${low} % left`, tone: low < 10 ? 'bad' : low < 30 ? 'wait' : 'ok', lines: [], bars }
}

const ofProject = (c: Card, key: string) => c.project.toLowerCase() === key || c.shown.toLowerCase().startsWith(`${key}-`)
const toneOf = (c: Card) => cardStatus(c)?.tone ?? (c.phase === 'done' ? 'ok' : 'wait')
export function prView(cards: Card[] | null, arg: string): StatusView | null {
  const [key, n] = arg.toLowerCase().split('#') as [string, string]
  const c = cards?.find(x => ofProject(x, key) && new RegExp(`/${n}(?![\\w-])`).test(prLink(x)?.url ?? ''))
  if (!c) return null
  const pr = c.prNow ?? (c.phase === 'done' ? 'merged' : 'open')
  return { title: `PR ${arg.toUpperCase()}`, state: pr, tone: pr === 'merged' ? 'ok' : toneOf(c), lines: [`${c.shown} · ${c.title}`], task: c.id }
}

export function opView(cards: Card[] | null, arg: string, ago: (at: number) => string): StatusView | null {
  const a = arg.toLowerCase()
  const c = cards?.find(x => x.id.toLowerCase() === a || x.shown.toLowerCase() === a)
  if (!c) return null
  const s = c.state
  const step = s ? c.plan[s.at] : undefined
  const what = step ? (step.action ? actionLabel(step.action) : step.id) : 'not started'
  const status = cardStatus(c)
  const state = s?.done ? 'done' : c.stopped ? 'stopped' : status?.text || (s?.acting ? 'running' : c.yourTurn ? 'your turn' : 'waiting')
  const since = s?.watch?.from ?? s?.since
  return {
    title: `${c.shown} · ${what}`,
    state,
    tone: s?.done ? 'ok' : c.stopped ? 'off' : status?.tone ?? (c.yourTurn ? 'wait' : 'ok'),
    lines: [c.title, ...(since && !s?.done ? [`since ${ago(since)}`] : [])],
    task: c.id,
  }
}
