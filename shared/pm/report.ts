import { weight, type Finding, type Round } from './verdict'

// A problem the user reports on a task that waits for them (a visual merge
// whose screenshots miss the feature, a bug): sent to the project's
// coordinator, never to the task's agent, with everything it needs to decide.
// The task keeps it (the card says "Problem reported 20:15") until the
// coordinator closes it or sends the step back, or the user withdraws it.
// block: the user's merge is refused while it is open.
export interface Report { at: number, text: string, shots: string[], block: boolean }

export const REPORT_MAX = 2000

// What the coordinator reads. shots: where it opens each chosen screenshot.
export interface ReportContext { id: string, title: string, step?: string, text: string, shots: string[], pr?: string, verdict?: string, block: boolean }

export function reportMessage(c: ReportContext): string {
  return [
    `The user reports a problem on task ${c.id} (${c.title}), at step ${c.step ?? '(not started)'}:`,
    ...c.text.split('\n').map(l => `> ${l}`),
    ...(c.shots.length ? ['Screenshots concerned:', ...c.shots.map(s => `- ${s}`)] : []),
    `PR: ${c.pr ?? 'none'}`,
    `Review: ${c.verdict ?? 'none'}`,
    c.block ? 'The merge is blocked until you close this report.' : 'The merge is not blocked.',
    `Decide: tell the agent precise fixes (\`wherdr pm tell ${c.id}\`), send the step back to the worker (\`wherdr pm report back ${c.id} "<what to fix>"\`), or add a follow-up task; then close it with \`wherdr pm report close ${c.id} "<what you did>"\` (report back closes it too). Never ask the user to relay it to the agent.`,
  ].join('\n')
}

// The review's verdict before the current step, as the To do view shows it.
export function reviewLine(plan: { ends?: string, id: string }[], at: number, rounds: Record<string, number>) {
  const review = plan.slice(0, at).findLast(s => s.ends === 'verdict')
  if (!review) return
  const n = rounds[review.id] ?? 0
  return n ? `Review passed, ${n} send-back${n > 1 ? 's' : ''}` : 'Review passed'
}

type Planned = { ends?: string, id: string, holder?: string }

// The worker's closing report before the current step, as the To do view shows it (Markdown).
export function workerNote(plan: Planned[], s: { at: number, proofs: Record<string, { report?: string }> }) {
  return plan.slice(0, s.at).filter(p => p.holder === 'worker' && p.ends === 'report').map(p => s.proofs[p.id]?.report?.trim()).findLast(Boolean)
}

// A finding as a Markdown list item: its weight, title and where.
export const findingLine = (f: Finding, sev = true) => `- ${sev ? `[${weight(f)}] ` : ''}${f.title}${f.where ? ` (\`${f.where}\`)` : ''}`

// The review before the current step, in Markdown: its verdict, what it sent
// back (fixed during the rounds, each finding once) and what it left as minor.
export function reviewNote(plan: Planned[], s: { at: number, rounds: Record<string, number>, reviews?: Record<string, Round[]>, minor?: Record<string, Finding[]> }) {
  const line = reviewLine(plan, s.at, s.rounds)
  if (!line) return
  const id = plan.slice(0, s.at).findLast(p => p.ends === 'verdict')!.id
  const fixed = [...new Map((s.reviews?.[id] ?? []).flatMap(r => r.findings).map(f => [f.id, f])).values()]
  const minor = s.minor?.[id] ?? []
  return [
    `${line}.`,
    ...(fixed.length ? ['', '**Fixed during the rounds**', ...fixed.map(f => findingLine(f))] : []),
    ...(minor.length ? ['', '**Left as minor**', ...minor.map(f => findingLine(f, false))] : []),
    ...(!fixed.length && !minor.length && s.minor?.[id] ? ['', 'No finding.'] : []),
  ].join('\n')
}
