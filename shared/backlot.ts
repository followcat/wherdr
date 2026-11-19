// The "backlot/1" summary document of each machine, published by backlot-stage
// (a herdr-core shared document named 'backlot'). wherdr only reads it, and
// validates every action the Studio view runs on the studio's machine.
export interface BacklotSummary {
  schema: 'backlot/1'
  updated_ms: number
  backlot_version?: string | null
  studios: BacklotStudio[]
  hollywood?: BacklotHollywood | null
}

export interface BacklotStudio {
  id: string
  title: string
  state: string
  requirement_version: number
  mode?: string
  open_reviews: number
  waiting: number
  error?: string | null
  next?: string | null
  repo?: string | null
  ready_to_finish?: boolean
  tasks_done?: number
  tasks_total?: number
  tasks?: BacklotTask[]
  roles: BacklotRole[]
}

export interface BacklotTask {
  id: string
  title: string
  status: string
  priority: string
  requirement_version: number
  behind?: boolean
  rework_rounds: number
  rework_cap: number
  actor_role?: string | null
  actor_name?: string | null
  waits_for?: string[]
  latest_delivery?: number | null
  latest_checks?: string | null
  latest_verdict?: string | null
}

export interface BacklotRole {
  role: string
  name: string
  terminal?: string | null
  runner?: string | null
  model?: string | null
  effort?: string | null
  state: string
  doing?: string | null
  work?: 'working' | 'waiting' | 'blocked' | null
  failed?: string | null
  workdir?: string | null
  task?: string | null
  priority?: string | null
  resumable?: boolean
  since_ms?: number
  attention?: string | null
  attention_user?: boolean
  attention_seq?: number | null
  attention_detail?: string | null
}

export interface BacklotHollywood {
  state: string
  runner?: string | null
  model?: string | null
  effort?: string | null
  headline?: string | null
  cards?: BacklotCard[]
}

export interface BacklotCard {
  id: string
  studio: string
  action: string
  why: string
}

export interface BacklotMachineView {
  machine: string
  label: string
  stageRunning: boolean
  backlotVersion: string | null
  summary: BacklotSummary
}

export type BacklotVisualState = 'working' | 'blocked' | 'idle' | 'done' | 'inactive' | 'unknown'

export type BacklotAction =
  | { kind: 'approve', machine: string, studio: string, person: string, decision: 'allow' | 'deny' }
  | { kind: 'tell', machine: string, studio: string, role: string, text: string }
  | { kind: 'tell-hollywood', machine: string, text: string }
  | { kind: 'attention-clear', machine: string, studio: string, seq: number }
  | { kind: 'card-apply', machine: string, cardId: string }
  | { kind: 'card-cancel', machine: string, cardId: string }
  | { kind: 'stage-start', machine: string }

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const optStr = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const optNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean => v === true

function parseRole(raw: unknown): BacklotRole | null {
  const o = isObject(raw) ? raw : null
  const role = o ? str(o.role) : ''
  const name = o ? str(o.name) : ''
  if (!o || !role || !name) return null
  const work = o.work === 'working' || o.work === 'waiting' || o.work === 'blocked' ? o.work : null
  return {
    role,
    name,
    terminal: optStr(o.terminal),
    runner: optStr(o.runner),
    model: optStr(o.model),
    effort: optStr(o.effort),
    state: str(o.state) || 'unknown',
    doing: optStr(o.doing),
    work,
    failed: optStr(o.failed),
    workdir: optStr(o.workdir),
    task: optStr(o.task),
    priority: optStr(o.priority),
    resumable: bool(o.resumable),
    ...(optNum(o.since_ms) != null ? { since_ms: o.since_ms as number } : {}),
    attention: optStr(o.attention),
    attention_user: bool(o.attention_user),
    attention_seq: optNum(o.attention_seq),
    attention_detail: optStr(o.attention_detail),
  }
}

function parseTask(raw: unknown): BacklotTask | null {
  const o = isObject(raw) ? raw : null
  if (!o || !str(o.id)) return null
  return {
    id: str(o.id),
    title: str(o.title),
    status: str(o.status),
    priority: str(o.priority),
    requirement_version: num(o.requirement_version),
    behind: bool(o.behind),
    rework_rounds: num(o.rework_rounds),
    rework_cap: num(o.rework_cap),
    actor_role: optStr(o.actor_role),
    actor_name: optStr(o.actor_name),
    waits_for: Array.isArray(o.waits_for) ? o.waits_for.map(str).filter(Boolean) : [],
    latest_delivery: optNum(o.latest_delivery),
    latest_checks: optStr(o.latest_checks),
    latest_verdict: optStr(o.latest_verdict),
  }
}

function parseStudio(raw: unknown): BacklotStudio | null {
  const o = isObject(raw) ? raw : null
  const id = o ? str(o.id) : ''
  if (!o || !id) return null
  const roles = Array.isArray(o.roles) ? o.roles.map(parseRole).filter((r): r is BacklotRole => r !== null) : []
  const tasks = Array.isArray(o.tasks) ? o.tasks.map(parseTask).filter((t): t is BacklotTask => t !== null) : []
  return {
    id,
    title: str(o.title) || id,
    state: str(o.state) || 'live',
    requirement_version: num(o.requirement_version),
    mode: optStr(o.mode) ?? undefined,
    open_reviews: num(o.open_reviews),
    waiting: num(o.waiting),
    error: optStr(o.error),
    next: optStr(o.next),
    repo: optStr(o.repo),
    ready_to_finish: bool(o.ready_to_finish),
    tasks_done: num(o.tasks_done),
    tasks_total: num(o.tasks_total),
    tasks,
    roles,
  }
}

function parseHollywood(raw: unknown): BacklotHollywood | null {
  if (!isObject(raw)) return null
  const cards = Array.isArray(raw.cards)
    ? raw.cards.map((c): BacklotCard | null => {
      const o = isObject(c) ? c : null
      return o && str(o.id) ? { id: str(o.id), studio: str(o.studio), action: str(o.action), why: str(o.why) } : null
    }).filter((c): c is BacklotCard => c !== null)
    : []
  return {
    state: str(raw.state) || 'down',
    runner: optStr(raw.runner),
    model: optStr(raw.model),
    effort: optStr(raw.effort),
    headline: optStr(raw.headline),
    cards,
  }
}

// A document of unknown shape reduced to what the Studio view reads; null when
// it is not a backlot/1 summary. Never throws on malformed or older documents.
export function parseBacklotDoc(value: unknown): BacklotSummary | null {
  if (!isObject(value) || value.schema !== 'backlot/1') return null
  const studios = Array.isArray(value.studios)
    ? value.studios.map(parseStudio).filter((s): s is BacklotStudio => s !== null)
    : []
  return {
    schema: 'backlot/1',
    updated_ms: num(value.updated_ms),
    backlot_version: optStr(value.backlot_version),
    studios,
    hollywood: parseHollywood(value.hollywood),
  }
}

// A role mapped onto wherdr's state tokens: attention first (the user's turn),
// then the work in progress, then its terminal state.
export function roleVisualState(role: BacklotRole): BacklotVisualState {
  if (role.state === 'live') {
    if ((role.attention || '').trim()) return 'blocked'
    if (role.work === 'working') return 'working'
    if (role.work === 'blocked') return 'blocked'
    if (role.work === 'waiting') return 'idle'
    if (role.failed) return 'blocked'
    return 'idle'
  }
  if (role.state === 'finished' || role.state === 'done') return 'done'
  if (role.state === 'lost' || role.state === 'closed') return 'inactive'
  return 'unknown'
}

// The studio's own health, for the square on its card in the Studio view.
export function studioVisualState(studio: BacklotStudio): BacklotVisualState {
  if (studio.error) return 'blocked'
  const states = studio.roles.map(roleVisualState)
  if (states.includes('blocked')) return 'blocked'
  if (states.includes('working')) return 'working'
  if (studio.state === 'finished') return 'done'
  if (states.length && states.every(s => s === 'inactive' || s === 'unknown')) return 'inactive'
  return 'idle'
}

// Roles waiting for the user, the ones only the user can unblock first.
export function studioWaitingAttentions(studio: BacklotStudio): BacklotRole[] {
  const seq = (r: BacklotRole) => r.attention_seq ?? Number.MAX_SAFE_INTEGER
  return studio.roles
    .filter(r => (r.attention || '').trim())
    .sort((a, b) => Number(Boolean(b.attention_user)) - Number(Boolean(a.attention_user)) || seq(a) - seq(b))
}

// Machine of the action: '' is this one, otherwise a herdr-core machine name.
const SAFE_ID = /^[a-zA-Z0-9._-]{1,64}$/
const SAFE_MACHINE = /^$|^[a-zA-Z0-9._-]{1,64}$/
const CARD_ID = /^c\d{1,18}$/
const MAX_TEXT = 4000

// Every action the Studio view may run, from an untrusted body. Null refuses
// anything else: no unknown kind, no shell metacharacter, no oversized text.
export function validateBacklotAction(input: unknown): BacklotAction | null {
  if (!isObject(input)) return null
  const machine = typeof input.machine === 'string' && SAFE_MACHINE.test(input.machine) ? input.machine : null
  if (machine === null) return null
  switch (input.kind) {
    case 'approve': {
      const studio = typeof input.studio === 'string' && SAFE_ID.test(input.studio) ? input.studio : null
      const person = typeof input.person === 'string' && SAFE_ID.test(input.person) ? input.person : null
      const decision = input.decision === 'allow' || input.decision === 'deny' ? input.decision : null
      return studio && person && decision ? { kind: 'approve', machine, studio, person, decision } : null
    }
    case 'tell': {
      const studio = typeof input.studio === 'string' && SAFE_ID.test(input.studio) ? input.studio : null
      const role = typeof input.role === 'string' && SAFE_ID.test(input.role) ? input.role : null
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      return studio && role && text && text.length <= MAX_TEXT ? { kind: 'tell', machine, studio, role, text } : null
    }
    case 'tell-hollywood': {
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      return text && text.length <= MAX_TEXT ? { kind: 'tell-hollywood', machine, text } : null
    }
    case 'attention-clear': {
      const studio = typeof input.studio === 'string' && SAFE_ID.test(input.studio) ? input.studio : null
      const seq = typeof input.seq === 'number' && Number.isInteger(input.seq) && input.seq > 0 ? input.seq : null
      return studio && seq !== null ? { kind: 'attention-clear', machine, studio, seq } : null
    }
    case 'card-apply':
    case 'card-cancel': {
      const cardId = typeof input.cardId === 'string' && CARD_ID.test(input.cardId) ? input.cardId : null
      return cardId ? { kind: input.kind, machine, cardId } : null
    }
    case 'stage-start':
      return { kind: 'stage-start', machine }
    default:
      return null
  }
}

// The argv of the `backlot` command, in the order its CLI reads it.
export function buildBacklotCommand(action: BacklotAction): string[] {
  switch (action.kind) {
    case 'approve': return ['approve', '--studio', action.studio, '--person', action.person, '--decision', action.decision]
    case 'tell': return ['tell', '--studio', action.studio, action.role, '--text', action.text]
    case 'tell-hollywood': return ['tell', 'hollywood', '--text', action.text]
    case 'attention-clear': return ['attention', 'clear', '--studio', action.studio, String(action.seq)]
    case 'card-apply': return ['card', 'apply', action.cardId]
    case 'card-cancel': return ['card', 'cancel', action.cardId]
    case 'stage-start': return ['stage', 'start']
  }
}
