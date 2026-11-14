// A workflow change as a person reads it: per task type, the steps added,
// removed or changed, each changed field with its value before and after.
// The coordinator's proposal card and review show it; the JSON diff
// (templateDiff) stays for the details.
import type { Guards, Step, StepAction, Template, TaskType } from './workflow'
import { lineDiff } from './coordinator'

// before/after: the field's value as text, absent when it was not set.
export interface FieldChange { field: string, before?: string, after?: string }
// moved: kept, in another place among the kept steps (its fields may have changed too).
export type ChangeKind = 'added' | 'removed' | 'changed' | 'moved' | 'same'
// step: a removed step as it was, so a diagram can still draw what it did.
export interface StepChange { id: string, kind: ChangeKind, holder: string, ends?: string, fields: FieldChange[], step?: Step }
// steps: the new list in order, removed steps where they were; about: an added
// type in a few words ("6 steps, PR to develop, you merge").
export interface TypeChange { type: string, kind: 'added' | 'removed' | 'changed', fields: FieldChange[], steps: StepChange[], about?: string }
// all: the workflow's own fields (guards, instructions, prefs, worktree), for every type.
export interface WorkflowChanges { all: FieldChange[], types: TypeChange[] }

const MERGE_BY = { engine: 'automatic', user: 'you' } as Record<string, string>
const text = (v: unknown): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (Array.isArray(v)) return v.length ? v.join(', ') : undefined
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
const action = (a?: StepAction) => a && [a.kind, a.target ?? a.base, a.method, a.checks?.length ? `checks ${a.checks.join(', ')}` : ''].filter(Boolean).join(' ')

// A guards object, field by field: "merge protected", "protected branches"…
function guardFields(g?: Guards): Record<string, string | undefined> {
  return {
    'protected branches': text(g?.protected),
    'merge into protected': g?.merge?.protected && MERGE_BY[g.merge.protected],
    'merge': g?.merge?.others && MERGE_BY[g.merge.others],
    'contributor PRs': g?.contributorPrs,
  }
}

function compare(a: Record<string, string | undefined>, b: Record<string, string | undefined>): FieldChange[] {
  const out: FieldChange[] = []
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const before = a[field], after = b[field]
    if (before !== after) out.push({ field, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) })
  }
  return out
}

const prefFields = (p?: Template['prefs']) => Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, text(v)]))
const setupFields = (w?: Template['worktree']) => Object.fromEntries(Object.entries(w ?? {}).map(([k, v]) => [`worktree ${k}`, text(v)]))
const ownFields = (o?: { guards?: Guards, instructions?: string, prefs?: Template['prefs'], worktree?: Template['worktree'] }) =>
  ({ ...guardFields(o?.guards), 'instructions': text(o?.instructions), ...prefFields(o?.prefs), ...setupFields(o?.worktree) })

function stepFields(s: Step): Record<string, string | undefined> {
  const { id: _id, holder, ends, action: a, instructions, ...rest } = s
  return { holder: holder ?? 'none', ends, action: action(a), instructions, ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, text(v)])) }
}

// A type's steps, shared ones resolved by id.
const stepsOf = (t: Template, tt: TaskType) => tt.steps.map(s => (typeof s === 'string' ? t.steps?.[s] ?? { id: s } : s))

function stepChanges(oldSteps: Step[], newSteps: Step[]): StepChange[] {
  const before = new Map(oldSteps.map(s => [s.id, s]))
  const after = new Set(newSteps.map(s => s.id))
  const row = (s: Step, kind: ChangeKind, fields: FieldChange[] = []): StepChange =>
    ({ id: s.id, kind, holder: s.holder ?? 'none', ...(s.ends ? { ends: s.ends } : {}), fields, ...(kind === 'removed' ? { step: s } : {}) })
  // The kept steps out of the longest run still in order: moved.
  const kept = (l: Step[], other: Set<string>) => l.map(s => s.id).filter(id => other.has(id))
  const moved = new Set(lineDiff(kept(oldSteps, after), kept(newSteps, new Set(before.keys()))).filter(l => l.startsWith('+ ')).map(l => l.slice(2)))
  const out: StepChange[] = []
  // Removed steps go where they stood: before the next step that stays.
  let i = 0
  const flushRemoved = (until?: string) => {
    while (i < oldSteps.length && oldSteps[i]!.id !== until) {
      if (!after.has(oldSteps[i]!.id)) out.push(row(oldSteps[i]!, 'removed'))
      i++
    }
    if (i < oldSteps.length) i++
  }
  for (const s of newSteps) {
    const old = before.get(s.id)
    if (!old) { out.push(row(s, 'added')); continue }
    flushRemoved(s.id)
    const fields = compare(stepFields(old), stepFields(s))
    out.push(row(s, moved.has(s.id) ? 'moved' : fields.length ? 'changed' : 'same', fields))
  }
  flushRemoved()
  return out
}

function typeAbout(t: Template, tt: TaskType) {
  const steps = stepsOf(t, tt)
  const pr = steps.find(s => s.action?.kind === 'github.pr')?.action
  const merge = tt.guards?.merge?.others ?? t.guards?.merge?.others
  return [`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`, pr && (pr.base ? `PR to ${pr.base}` : 'PR'), merge && (merge === 'user' ? 'you merge' : 'automatic merge')].filter(Boolean).join(', ')
}

// What `next` changes in `old` (types left as they were are not listed).
export function workflowChanges(old: Template | null, next: Template): WorkflowChanges {
  const o = old ?? { id: next.id, taskTypes: {} }
  const types: TypeChange[] = []
  for (const type of new Set([...Object.keys(o.taskTypes), ...Object.keys(next.taskTypes)])) {
    const a = o.taskTypes[type], b = next.taskTypes[type]
    const fields = compare(ownFields(a), ownFields(b))
    const steps = stepChanges(a ? stepsOf(o, a) : [], b ? stepsOf(next, b) : [])
    const kind = !a ? 'added' : !b ? 'removed' : 'changed'
    if (kind !== 'changed' || fields.length || steps.some(s => s.kind !== 'same')) types.push({ type, kind, fields, steps, ...(kind === 'added' ? { about: typeAbout(next, b!) } : {}) })
  }
  return { all: compare(ownFields(o), ownFields(next)), types }
}

const fieldLine = (f: FieldChange) => (f.field === 'instructions' ? 'instructions edited' : `${f.field}: ${f.before ?? 'none'} → ${f.after ?? 'none'}`)
const stepLine = (s: StepChange) => (s.kind === 'added' ? `+ ${s.id}` : s.kind === 'removed' ? `− ${s.id}` : [`${s.id}${s.kind === 'moved' ? ' moved' : ''}`, s.fields.map(fieldLine).join(', ')].filter(Boolean).join(' '))

// The change in a few plain lines, one per type: "task: merge: you → automatic, land action: … checks smoke".
export function changeSummary(c: WorkflowChanges, max = 2): string[] {
  const lines = [
    ...(c.all.length ? [`all types: ${c.all.map(fieldLine).join(', ')}`] : []),
    ...c.types.map(t => (t.kind === 'added' ? `+ type ${t.type}${t.about ? ` (${t.about})` : ''}` : t.kind === 'removed' ? `type ${t.type} removed`
      : `${t.type}: ${[...t.fields.map(fieldLine), ...t.steps.filter(s => s.kind !== 'same').map(stepLine)].join(', ')}`)),
  ]
  return lines.length > max ? [...lines.slice(0, max - 1), `and ${lines.length - max + 1} more changes`] : lines
}

// The whole change in one line, for the top of the card and the review:
// its first change, then how many more.
export function changeHeadline(c: WorkflowChanges): string {
  const [first, ...rest] = changeSummary(c, Infinity)
  return first ? (rest.length ? `${first} · and ${rest.length} more ${rest.length === 1 ? 'change' : 'changes'}` : first) : ''
}

// For the diagram of a proposal: each step of one task type with its mark
// (added, removed, changed, moved) and the fields it changes. A change of the
// worker's or reviewer's agent or model (prefs, of the type or the whole
// workflow) marks the steps they hold; next: the proposed workflow, for a type
// whose steps did not change (a change to the whole workflow only).
export interface StepMark { kind: ChangeKind, holder: string, ends?: string, fields: FieldChange[], step?: Step }
// Plain words for the fields named in taskImpact.
const WORDS: Record<string, string> = { agent: 'agent', model: 'model', reviewAgent: 'agent', reviewModel: 'model', reviewFallbackAgent: 'fallback agent', reviewFallbackModel: 'fallback model', ends: 'ending', sendBack: 'send-back step', evidence: 'proofs' }
const HOLDER_PREFS: Record<string, string> = { agent: 'worker', model: 'worker', reviewAgent: 'reviewer', reviewModel: 'reviewer', reviewFallbackAgent: 'reviewer', reviewFallbackModel: 'reviewer' }
export function stepMarks(c: WorkflowChanges, type: string, next?: Template): Map<string, StepMark> {
  const t = c.types.find(x => x.type === type)
  const prefs = [...c.all, ...(t?.fields ?? [])].filter(f => HOLDER_PREFS[f.field])
  const out = new Map<string, StepMark>()
  const tt = next?.taskTypes[type]
  const steps = t?.steps ?? (tt ? stepsOf(next!, tt).map((x): StepChange => ({ id: x.id, kind: 'same', holder: x.holder ?? 'none', ...(x.ends ? { ends: x.ends } : {}), fields: [] })) : [])
  for (const s of steps) {
    const own = prefs.filter(f => HOLDER_PREFS[f.field] === s.holder && s.kind !== 'added' && s.kind !== 'removed')
    const kind = own.length && s.kind === 'same' ? 'changed' : s.kind
    out.set(s.id, { kind, holder: s.holder, ...(s.ends ? { ends: s.ends } : {}), fields: [...s.fields, ...own], ...(s.step ? { step: s.step } : {}) })
  }
  return out
}

// What changes for the tasks of one type, in one plain line:
// "For task tasks: a new step shots; review changes its model; merge: you → automatic".
export function taskImpact(c: WorkflowChanges, type: string, next?: Template): string {
  const t = c.types.find(x => x.type === type)
  if (t?.kind === 'added') return `A new task type ${type}${t.about ? `: ${t.about}` : ''}`
  if (t?.kind === 'removed') return `No more ${type} tasks: the type is removed`
  const steps = [...stepMarks(c, type, next)].flatMap(([id, m]) => m.kind === 'added' ? [`a new step ${id}`] : m.kind === 'removed' ? [`no more step ${id}`]
    : m.kind === 'moved' ? [`${id} moves`] : m.kind === 'changed' ? [`${id} changes its ${[...new Set(m.fields.map(f => WORDS[f.field] ?? f.field))].join(', ')}`] : [])
  const own = [...c.all, ...(t?.fields ?? [])].filter(f => !HOLDER_PREFS[f.field]).map(fieldLine)
  const parts = [...steps, ...own]
  return parts.length ? `For ${type} tasks: ${parts.join('; ')}` : ''
}
