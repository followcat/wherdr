// A routine wake in a coordinator's chat, read from its own text (never from
// the reply's words): its first line names the kind (shared/pm/wakes.ts
// wakeHead), its task lines say what happened to each task
// (shared/pm/autopilot.ts autopilotEvents: `WHR-352 (title): done`).
// Computed, no model call: the folded run's header and one line per wake.
import { wakeKindOf } from '../../shared/pm/wakes'

// What a wake is about, most pressing first (its icon and label).
export type WakeTone = 'stuck' | 'question' | 'ready' | 'done' | 'added' | 'incident' | 'step' | 'engine' | 'health' | 'run' | 'scheduled'
export const TONE_ORDER: WakeTone[] = ['stuck', 'question', 'ready', 'done', 'added', 'incident', 'step', 'engine', 'health', 'run', 'scheduled']
export const TONE_ICON: Record<WakeTone, string> = {
  stuck: 'i-lucide-triangle-alert', question: 'i-lucide-circle-help', ready: 'i-lucide-hourglass', done: 'i-lucide-check', added: 'i-lucide-plus',
  incident: 'i-lucide-siren', step: 'i-lucide-flag', engine: 'i-lucide-wrench', health: 'i-lucide-heart-pulse', run: 'i-lucide-play', scheduled: 'i-lucide-circle',
}
// A task's label on its row (after its chip), and the header's count.
const TASK_LABEL: Partial<Record<WakeTone, string>> = { stuck: 'stuck', question: 'question', ready: 'ready for you', done: 'merged', added: 'added' }
const LABEL: Record<WakeTone, string> = { ...TASK_LABEL, incident: 'Incident', step: 'Step check', engine: 'Engine', health: 'Health check', run: 'Run now', scheduled: 'Scheduled' } as Record<WakeTone, string>
const COUNT: Record<WakeTone, string> = { stuck: 'stuck', question: 'question', ready: 'waits for you', done: 'merged', added: 'added', incident: 'incident', step: 'step check', engine: 'engine', health: 'health check', run: 'run now', scheduled: 'quiet' }
const PLURAL = new Set<WakeTone>(['question', 'incident', 'step', 'health'])
// A tone the user should look at: the header stands out.
const FOR_USER = new Set<WakeTone>(['ready', 'question', 'stuck'])

const EVENT: Record<string, WakeTone> = { done: 'done', ready: 'ready', decide: 'ready', question: 'question', stuck: 'stuck', added: 'added' }
const TASK_LINE = /^([A-Z][A-Z0-9-]*-\d+) \(.*\): (done|ready|decide|question|stuck|added)(?::|$)/
const ABOUT = /^[^:]+: ([A-Z][A-Z0-9-]*-\d+) \(/

// `events`: each task line's task and kind (a tick may batch several).
export interface WakeEvent { id: string, tone: WakeTone }
export interface WakeSum { tone: WakeTone, tasks: string[], label: string, quiet: boolean, events: WakeEvent[] }

export function wakeSum(text: string): WakeSum {
  const kind = wakeKindOf(text) ?? 'autopilot'
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const events: WakeEvent[] = lines.map(l => TASK_LINE.exec(l)).filter(m => !!m).map(m => ({ id: m[1]!, tone: EVENT[m[2]!]! }))
  if (events.length) {
    const tone = TONE_ORDER.find(t => events.some(e => e.tone === t))!
    return { tone, tasks: [...new Set(events.map(e => e.id))], label: LABEL[tone], quiet: false, events }
  }
  const about = ABOUT.exec(lines[0] ?? '')?.[1]
  const tone: WakeTone = kind === 'autopilot' ? (lines.some(l => l.startsWith('The user asked you to run now')) ? 'run' : 'scheduled') : kind
  return { tone, tasks: about ? [about] : [], label: LABEL[tone], quiet: tone === 'scheduled' || tone === 'health', events: [] }
}

// The reply's first sentence, for its row.
export function firstSentence(text: string): string {
  const t = text.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim()
  return /^.+?[.!?…](?=\s|$)/.exec(t)?.[0] ?? t
}

// A task's chip: the full id, or only its number after one of the same project.
export interface Chip { id: string, text: string }
export const chipsOf = (ids: string[]): Chip[] => ids.map((id, i) => {
  const prev = ids[i - 1]?.replace(/\d+$/, '')
  return { id, text: prev && id.startsWith(prev) ? id.slice(prev.length) : id }
})

// The folded run's header: one part per tone. A task kind counts its tasks
// across every wake's events (a wake batching a merge and a ready one counts
// in both); another kind counts its wakes (quiet ones, a step check…).
export interface RunPart { tone: WakeTone, n: number, text: string, chips: Chip[] }
export interface RunSum { n: number, parts: RunPart[], forUser: boolean }
export function runSum(sums: WakeSum[]): RunSum {
  const parts = TONE_ORDER.flatMap((tone) => {
    const task = !!TASK_LABEL[tone]
    const mine = sums.filter(s => !s.events.length && s.tone === tone)
    const ids = [...new Set(task ? sums.flatMap(s => s.events.filter(e => e.tone === tone).map(e => e.id)) : mine.flatMap(s => s.tasks))]
    const n = task ? ids.length : mine.length
    if (!n) return []
    return [{ tone, n, text: `${n} ${COUNT[tone]}${n > 1 && PLURAL.has(tone) ? 's' : ''}`, chips: chipsOf(ids) }]
  })
  return { n: sums.length, parts, forUser: sums.some(s => FOR_USER.has(s.tone)) }
}

// Consecutive quiet wakes in a run, as [first, last] indexes, two or more each.
export function quietStreaks(sums: WakeSum[]): [number, number][] {
  const out: [number, number][] = []
  let from = -1
  sums.forEach((s, i) => {
    if (s.quiet && from < 0) from = i
    if (from >= 0 && (!s.quiet || i === sums.length - 1)) {
      const to = s.quiet ? i : i - 1
      if (to > from) out.push([from, to])
      from = -1
    }
  })
  return out
}
