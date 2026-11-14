import { findingLine } from './report'
import type { Round } from './verdict'

// The task's hand-offs between its agents and the user, oldest first, built
// from what the task keeps: its log, the worker's reports (each kept as it
// arrived, Task.workReports; a task older than them: only its last one), the review's
// send-back rounds and its passing verdict. With `all`, the engine's routine
// lines too, marked `routine`: the sheet's History is the whole log in one timeline.

export type Who = 'worker' | 'reviewer' | 'user' | 'coordinator' | 'engine'
// label: what the entry is (Done, Sent back…), empty for a plain log line;
// agent: the program and model behind a worker or reviewer; text: Markdown.
export interface HistoryEntry { at: number, who: Who, agent?: string, label: string, text: string, routine?: true }
// The labels of the agents' reports and verdicts (the sheet's Comments).
export const REPORTS = new Set(['Done', 'Fixed', 'Sent back', 'Passed'])

type LogEntry = { at: number, by: string, text: string }
// A worker's report as it arrived, on its step (Task.workReports).
export type WorkReport = { step: string, text: string }
type Planned = { id: string }
type State = { proofs: Record<string, { report?: string }>, reviews?: Record<string, Round[]>, minor?: Record<string, Round['findings']> }

// The engine's lines kept: what it handed the worker (a catch-up, red CI, a
// fix) and its update of the PR with its base; the rest is bookkeeping.
const ENGINE_KEPT = /^(?:fix-base|catch-up|rerun-ci|ci-to-agent|fix [\w-]+): |: updated with |conflicts with or is behind|^gave up: /
const DONE = /^([\w-]+): done$/
const VERDICT = /^([\w-]+): verdict, (\d+) finding/

function whoOf(by: string): { who: Who, agent?: string } {
  const [role, ...rest] = by.split(' ')
  if (role === 'worker' || role === 'reviewer') return { who: role, ...(rest.length ? { agent: rest.join(' ') } : {}) }
  if (by === 'user' || by === 'engine') return { who: by }
  return { who: 'coordinator' }
}

const list = (fs: Round['findings'], sev = true) => fs.map(f => findingLine(f, sev)).join('\n')

export function taskHistory(log: LogEntry[], plan: Planned[], s?: State, all = false, reports: WorkReport[] = []): HistoryEntry[] {
  const known = new Set(plan.map(p => p.id))
  // Each review step's verdicts, newest first: its passing one (the last, when
  // kept) and its send-backs, matched from the end on their number of findings.
  const verdicts = new Map<number, { round?: Round, pass?: Round['findings'] }>()
  for (const id of known) {
    const rounds = [...(s?.reviews?.[id] ?? [])]
    let pass = s?.minor?.[id]
    for (let i = log.length - 1; i >= 0; i--) {
      const m = VERDICT.exec(log[i]!.text)
      if (!m || m[1] !== id || !log[i]!.by.startsWith('reviewer')) continue
      const n = Number(m[2])
      if (pass && pass.length === n) { verdicts.set(i, { pass }); pass = undefined; continue }
      pass = undefined
      if (rounds.length && rounds.at(-1)!.findings.length <= n) verdicts.set(i, { round: rounds.pop() })
    }
  }
  // Each step's reports go on its "done" lines, matched from the newest (the
  // log shown may be cut at its start). None kept: the step's last report on its last "done".
  const reportAt = new Map<number, string>()
  for (const id of known) {
    const dones = log.flatMap((e, i) => (e.by.startsWith('worker') && DONE.exec(e.text)?.[1] === id ? [i] : []))
    const kept = reports.filter(r => r.step === id).map(r => r.text)
    if (!kept.length && s?.proofs[id]?.report && dones.length) kept.push(s.proofs[id].report!)
    for (let k = 1; k <= Math.min(dones.length, kept.length); k++) reportAt.set(dones.at(-k)!, kept.at(-k)!)
  }

  const out: HistoryEntry[] = []
  let sentBack: Round | undefined
  log.forEach((e, i) => {
    const { who, agent } = whoOf(e.by)
    const base = { at: e.at, who, ...(agent ? { agent } : {}) }
    if (who === 'engine' && !ENGINE_KEPT.test(e.text)) return void (all && out.push({ ...base, label: '', text: e.text, routine: true }))
    const done = who === 'worker' ? DONE.exec(e.text) : null
    if (done) {
      const report = reportAt.get(i)?.trim()
      const disputed = sentBack?.disputed?.length ? `Contested: ${sentBack.disputed.join(', ')}` : ''
      out.push({ ...base, label: sentBack ? 'Fixed' : 'Done', text: [report || (sentBack ? 'Fixed what the review sent back.' : 'Reported done.'), disputed].filter(Boolean).join('\n\n') })
      sentBack = undefined
      return
    }
    // The user's send-back: the worker's next report is a fix too.
    if (who === 'user' && /: sent back by the user/.test(e.text)) sentBack = { findings: [] }
    const v = who === 'reviewer' && VERDICT.exec(e.text) ? verdicts.get(i) : undefined
    if (v?.round) {
      sentBack = v.round
      out.push({ ...base, label: 'Sent back', text: list(v.round.findings) })
    }
    else if (v?.pass) out.push({ ...base, label: 'Passed', text: v.pass.length ? `Left as minor:\n\n${list(v.pass, false)}` : 'No finding.' })
    else out.push({ ...base, label: '', text: e.text })
  })
  return out
}
