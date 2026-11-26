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

export type BacklotDesignPhase =
  | 'idle'
  | 'suggest_skip'
  | 'waiting_proposal'
  | 'waiting_buildability'
  | 'waiting_summary'
  | 'waiting_user'
  | 'signed'

export interface BacklotDesignQuestion {
  id: string
  prompt: string
  recommendation: string
  section_ref?: string | null
}

export interface BacklotDesign {
  version: number
  round: number
  phase: BacklotDesignPhase
  waiting_user: boolean
  suggest_skip: boolean
  skip_reason?: string | null
  doc_file: string
  summary?: string | null
  questions: BacklotDesignQuestion[]
  waiting_since_ms?: number | null
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
  needs_upgrade?: boolean
  unknown_kinds?: string[]
  design?: BacklotDesign | null
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
  asks?: string | null
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
  session?: string
  machine: string
  label: string
  stageRunning: boolean
  backlotVersion: string | null
  summary: BacklotSummary
}

export type BacklotVisualState = 'working' | 'blocked' | 'idle' | 'done' | 'inactive' | 'unknown'

export type BacklotAction =
  | { kind: 'approve', session?: string, machine: string, studio: string, person: string, decision: 'allow' | 'deny' }
  | { kind: 'tell', session?: string, machine: string, studio: string, role: string, text: string }
  | { kind: 'tell-hollywood', session?: string, machine: string, text: string }
  | { kind: 'attention-clear', session?: string, machine: string, studio: string, seq: number }
  | { kind: 'card-apply', session?: string, machine: string, cardId: string }
  | { kind: 'card-cancel', session?: string, machine: string, cardId: string }
  | { kind: 'stage-start', session?: string, machine: string }
  | { kind: 'design-sign', session?: string, machine: string, studio: string, skip: boolean, reason?: string, note?: string }
  | { kind: 'design-open', session?: string, machine: string, studio: string, req?: number }

export interface BacklotDocQuery {
  session?: string
  machine: string
  studio: string
  file: string
}

export interface BacklotDesignSection {
  id: string
  level: 2 | 3
  label: string
  text: string
}

export function backlotActionTarget(view: Pick<BacklotMachineView, 'machine' | 'session'>): { machine: string, session?: string } {
  return {
    machine: view.machine,
    ...(view.session !== undefined ? { session: view.session } : {}),
  }
}

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
    asks: optStr(o.asks),
    attention_user: bool(o.attention_user),
    attention_seq: optNum(o.attention_seq),
    attention_detail: optStr(o.attention_detail),
  }
}

const DESIGN_PHASES = new Set<BacklotDesignPhase>([
  'idle',
  'suggest_skip',
  'waiting_proposal',
  'waiting_buildability',
  'waiting_summary',
  'waiting_user',
  'signed',
])
const MAX_DESIGN_QUESTIONS = 3

function parseDesignQuestion(raw: unknown): BacklotDesignQuestion | null {
  const o = isObject(raw) ? raw : null
  const id = o ? str(o.id) : ''
  const prompt = o ? str(o.prompt) : ''
  if (!o || !id || !prompt) return null
  return {
    id,
    prompt,
    recommendation: str(o.recommendation),
    section_ref: optStr(o.section_ref),
  }
}

function parseDesign(raw: unknown): BacklotDesign | null {
  const o = isObject(raw) ? raw : null
  const phaseRaw = o ? str(o.phase) : ''
  if (!o || !DESIGN_PHASES.has(phaseRaw as BacklotDesignPhase)) return null
  const phase = phaseRaw as BacklotDesignPhase
  const questions = Array.isArray(o.questions)
    ? o.questions.map(parseDesignQuestion).filter((q): q is BacklotDesignQuestion => q !== null).slice(0, MAX_DESIGN_QUESTIONS)
    : []
  return {
    version: num(o.version),
    round: num(o.round),
    phase,
    waiting_user: typeof o.waiting_user === 'boolean' ? o.waiting_user : (phase === 'waiting_user' || phase === 'suggest_skip'),
    suggest_skip: typeof o.suggest_skip === 'boolean' ? o.suggest_skip : phase === 'suggest_skip',
    skip_reason: optStr(o.skip_reason),
    doc_file: str(o.doc_file),
    summary: optStr(o.summary),
    questions,
    waiting_since_ms: optNum(o.waiting_since_ms),
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
  const unknown_kinds = Array.isArray(o.unknown_kinds) ? o.unknown_kinds.map(str).filter(Boolean) : []
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
    needs_upgrade: bool(o.needs_upgrade),
    unknown_kinds,
    design: parseDesign(o.design),
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

export function waitingDesign(studio: BacklotStudio): BacklotDesign | null {
  if (studio.needs_upgrade || studio.state === 'finished' || !studio.design) return null
  return studio.design.phase === 'waiting_user' || studio.design.phase === 'suggest_skip' ? studio.design : null
}

// Warm asks bucket: open role `tell user` questions plus a waiting design decision.
export function studioAsksCount(studio: BacklotStudio): number {
  const roleAsks = studio.roles.filter(r => Boolean(r.asks?.trim())).length
  return roleAsks + (waitingDesign(studio) ? 1 : 0)
}

export function designFrozenDoc(design: Pick<BacklotDesign, 'version' | 'doc_file'>): string {
  const raw = design.doc_file.trim()
  if (!raw) return `design/v${design.version}-final.md`
  return raw.endsWith('-final.md') ? raw : raw.replace(/\.md$/, '-final.md')
}

const QUIET_PHASE: Partial<Record<BacklotDesignPhase, string>> = {
  waiting_proposal: 'proposal',
  waiting_buildability: 'buildability',
  waiting_summary: 'summary',
  signed: 'signed',
}

export function designQuietStatus(design: BacklotDesign | null | undefined): string | null {
  if (!design) return null
  if (design.phase === 'signed' && design.suggest_skip) return 'design · skipped'
  const label = QUIET_PHASE[design.phase]
  return label ? `design · R${design.round} · ${label}` : null
}

// Extract jumpable `## R<r>` and `### §R<r>.<W|D|P|U>` headings outside code fences.
export function extractDesignSections(markdown: string): BacklotDesignSection[] {
  const sections: BacklotDesignSection[] = []
  let fence = false
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim()
    if (/^(`{3,}|~{3,})/.test(line)) { fence = !fence; continue }
    if (fence) continue
    const r = /^##\s+(R\d+(?:\b.*)?)$/.exec(line)
    if (r) {
      const text = r[1]!.trim()
      sections.push({ id: `design-sec-${sections.length}`, level: 2, label: text.replace(/\s*\(#\d+\)$/, ''), text })
      continue
    }
    const s = /^###\s+(§R\d+\.[WDPU]\+?.*)$/.exec(line)
    if (s) {
      const text = s[1]!.trim()
      const label = text.replace(/\s*\(#\d+\)$/, '').replace(/\s*·\s*[^·]+$/, '')
      sections.push({ id: `design-sec-${sections.length}`, level: 3, label, text })
    }
  }
  return sections
}

// Machine of the action: '' is this one, otherwise a herdr-core machine name.
// Session of the action: '' is primary, otherwise the session tab key.
const SAFE_ID = /^[a-zA-Z0-9._-]{1,64}$/
const SAFE_MACHINE = /^$|^[a-zA-Z0-9._-]{1,64}$/
const SAFE_SESSION = /^$|^[a-zA-Z0-9._-]{1,64}$/
const CARD_ID = /^c\d{1,18}$/
const MAX_TEXT = 4000
export const BACKLOT_DESIGN_DOC_RE = /^design\/v[0-9]+(-final)?\.md$/

function parseTarget(input: Record<string, unknown>): { session?: string, machine: string } | null {
  const machine = typeof input.machine === 'string' && SAFE_MACHINE.test(input.machine) ? input.machine : null
  if (machine === null) return null
  const session = input.session === undefined
    ? undefined
    : typeof input.session === 'string' && SAFE_SESSION.test(input.session) ? input.session : null
  if (session === null) return null
  return session !== undefined ? { session, machine } : { machine }
}

// Every action the Studio view may run, from an untrusted body. Null refuses
// anything else: no unknown kind, no shell metacharacter, no oversized text.
export function validateBacklotAction(input: unknown): BacklotAction | null {
  if (!isObject(input)) return null
  const target = parseTarget(input)
  if (!target) return null
  switch (input.kind) {
    case 'approve': {
      const studio = typeof input.studio === 'string' && SAFE_ID.test(input.studio) ? input.studio : null
      const person = typeof input.person === 'string' && SAFE_ID.test(input.person) ? input.person : null
      const decision = input.decision === 'allow' || input.decision === 'deny' ? input.decision : null
      return studio && person && decision ? { kind: 'approve', ...target, studio, person, decision } : null
    }
    case 'tell': {
      const studio = typeof input.studio === 'string' && SAFE_ID.test(input.studio) ? input.studio : null
      const role = typeof input.role === 'string' && SAFE_ID.test(input.role) ? input.role : null
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      return studio && role && text && text.length <= MAX_TEXT ? { kind: 'tell', ...target, studio, role, text } : null
    }
    case 'tell-hollywood': {
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      return text && text.length <= MAX_TEXT ? { kind: 'tell-hollywood', ...target, text } : null
    }
    case 'attention-clear': {
      const studio = typeof input.studio === 'string' && SAFE_ID.test(input.studio) ? input.studio : null
      const seq = typeof input.seq === 'number' && Number.isInteger(input.seq) && input.seq > 0 ? input.seq : null
      return studio && seq !== null ? { kind: 'attention-clear', ...target, studio, seq } : null
    }
    case 'card-apply':
    case 'card-cancel': {
      const cardId = typeof input.cardId === 'string' && CARD_ID.test(input.cardId) ? input.cardId : null
      return cardId ? { kind: input.kind, ...target, cardId } : null
    }
    case 'stage-start':
      return { kind: 'stage-start', ...target }
    case 'design-sign': {
      const studio = typeof input.studio === 'string' && SAFE_ID.test(input.studio) ? input.studio : null
      const skip = typeof input.skip === 'boolean' ? input.skip : null
      if (!studio || skip === null) return null
      let reason: string | undefined
      if (input.reason !== undefined) {
        if (typeof input.reason !== 'string' || !skip) return null
        reason = input.reason.trim()
        if (!reason || reason.length > MAX_TEXT) return null
      }
      let note: string | undefined
      if (input.note !== undefined) {
        if (typeof input.note !== 'string') return null
        const trimmed = input.note.trim()
        if (trimmed.length > MAX_TEXT) return null
        if (trimmed) note = trimmed
      }
      return {
        kind: 'design-sign',
        ...target,
        studio,
        skip,
        ...(reason !== undefined ? { reason } : {}),
        ...(note !== undefined ? { note } : {}),
      }
    }
    case 'design-open': {
      const studio = typeof input.studio === 'string' && SAFE_ID.test(input.studio) ? input.studio : null
      if (!studio) return null
      let req: number | undefined
      if (input.req !== undefined) {
        if (typeof input.req !== 'number' || !Number.isInteger(input.req) || input.req <= 0) return null
        req = input.req
      }
      return {
        kind: 'design-open',
        ...target,
        studio,
        ...(req !== undefined ? { req } : {}),
      }
    }
    default:
      return null
  }
}

export function validateBacklotDocQuery(input: unknown): BacklotDocQuery | null {
  if (!isObject(input)) return null
  const machine = input.machine === undefined ? '' : input.machine
  const target = parseTarget({ machine, ...(input.session !== undefined ? { session: input.session } : {}) })
  if (!target) return null
  const studio = typeof input.studio === 'string' && SAFE_ID.test(input.studio) ? input.studio : null
  const file = typeof input.file === 'string' && BACKLOT_DESIGN_DOC_RE.test(input.file) ? input.file : null
  return studio && file ? { ...target, studio, file } : null
}

// The argv of the `backlot` command, in the order its CLI reads it.
export function buildBacklotCommand(action: BacklotAction): string[] {
  switch (action.kind) {
    case 'approve': return ['approve', '--studio', action.studio, '--person', action.person, '--decision', action.decision]
    case 'tell': return ['tell', '--studio', action.studio, action.role, '--text', action.text, '--as', 'user']
    case 'tell-hollywood': return ['tell', 'hollywood', '--text', action.text]
    case 'attention-clear': return ['attention', 'clear', '--studio', action.studio, String(action.seq)]
    case 'card-apply': return ['card', 'apply', action.cardId]
    case 'card-cancel': return ['card', 'cancel', action.cardId]
    case 'stage-start': return ['stage', 'start']
    case 'design-sign': return [
      'design', 'sign', '--studio', action.studio,
      ...(action.skip ? ['--skip', ...(action.reason ? ['--reason', action.reason] : [])] : []),
      ...(action.note ? ['--note', action.note] : []),
      '--as', 'user',
    ]
    case 'design-open': return [
      'design', 'open', '--studio', action.studio,
      ...(action.req !== undefined ? ['--req', String(action.req)] : []),
      '--as', 'user',
    ]
  }
}

export function buildBacklotReportCommand(studio: string, file: string): string[] {
  return ['report', 'show', '--studio', studio, '--file', file]
}
