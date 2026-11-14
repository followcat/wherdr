// Verdict steps: the reviewer describes (findings as JSON), the engine decides.
// After N send-backs nothing is sent back on its own: the engine sorts what
// remains and recommends one outcome; the choice goes to Your turn.

export const SEVERITIES = ['minor', 'major', 'critical'] as const
export type Severity = typeof SEVERITIES[number]

export interface Finding {
  id: string // short and stable: the reviewer reuses it while the point stands
  severity: Severity
  title: string
  where?: string
  proof?: string // a command and its output, a line, a failing case
  preexisting?: boolean // already there before the task: never sends back
  outOfScope?: boolean // right to ask, but not this task's job
}

// One send-back: the findings that sent it back, the diff size the server
// measured then, and the findings the worker contested in its answer.
// head: the commit the round read; the next round reviews only what came after it.
export interface Round { findings: Finding[], diffLines?: number, disputed?: string[], head?: string }

export const REVIEW_FORMAT = [
  'End with your verdict as JSON, nothing else on those lines:',
  '{"findings":[{"id":"short-slug","severity":"minor|major|critical","title":"…","where":"file:line","proof":"…","preexisting":false,"outOfScope":false}]}',
  'An empty list passes. A major or critical finding needs its proof. Keep the id of a finding that still stands.',
  'Never ask for CI to run or for the user\'s approval: the engine checks those.',
].join('\n')

// Reads the reviewer's JSON (the last {...} block of its answer).
export function parseFindings(text: string): Finding[] | { error: string } {
  const start = text.lastIndexOf('{"findings"')
  let v: unknown
  try { v = JSON.parse(start >= 0 ? text.slice(start, text.lastIndexOf('}') + 1) : text) }
  catch { return { error: 'The verdict is not valid JSON' } }
  const list = (v as { findings?: unknown })?.findings
  if (!Array.isArray(list)) return { error: 'The verdict needs a "findings" list' }
  const out: Finding[] = []
  for (const [i, f] of list.entries()) {
    if (!f || typeof f !== 'object') return { error: `findings[${i}] must be an object` }
    const { id, severity, title } = f as Record<string, unknown>
    if (!SEVERITIES.includes(severity as Severity)) return { error: `findings[${i}].severity must be one of ${SEVERITIES.join(', ')}` }
    if (typeof title !== 'string' || !title.trim()) return { error: `findings[${i}].title is required` }
    const g = f as Record<string, unknown>
    const text = (k: string) => (typeof g[k] === 'string' && (g[k] as string).trim() ? { [k]: (g[k] as string).trim() } : {})
    out.push({
      id: typeof id === 'string' && id.trim() ? id.trim() : `f${i + 1}`, severity: severity as Severity, title: title.trim(),
      ...text('where'), ...text('proof'), ...(g.preexisting === true ? { preexisting: true } : {}), ...(g.outOfScope === true ? { outOfScope: true } : {}),
    })
  }
  return out
}

// A preview line that holds a reviewer's verdict JSON (often cut at 200 characters),
// read back: the full list when it parses, else what the cut text still shows.
// null when the text holds no verdict.
export interface VerdictGlance { complete: boolean, count: Partial<Record<Severity, number>>, total: number, title?: string }
export function verdictGlance(text: string): VerdictGlance | null {
  const start = text.search(/\{\s*"findings"\s*:/)
  if (start < 0) return null
  const json = text.slice(start)
  const parsed = parseFindings(json)
  const complete = Array.isArray(parsed)
  const severities = complete ? parsed.map(f => f.severity) : [...json.matchAll(/"severity"\s*:\s*"(minor|major|critical)"/g)].map(m => m[1] as Severity)
  const rawTitle = complete ? parsed[0]?.title : /"title"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(json)?.[1]?.replace(/\\(.)/g, '$1')
  const count: Partial<Record<Severity, number>> = {}
  for (const s of severities) count[s] = (count[s] ?? 0) + 1
  return { complete, count, total: severities.length, ...(rawTitle ? { title: rawTitle } : {}) }
}

// What a finding weighs: preexisting = minor; without proof, one level down.
export function weight(f: Finding): Severity {
  if (f.preexisting) return 'minor'
  const i = SEVERITIES.indexOf(f.severity)
  return SEVERITIES[f.proof?.trim() ? i : Math.max(0, i - 1)]!
}
export const blocking = (fs: Finding[]) => fs.filter(f => weight(f) !== 'minor')

export type Choice = 'pass' | 'round' | 'worker' | 'reviewer' | 'split' | 'swap' | 'abandon'
export const CHOICES: Choice[] = ['pass', 'round', 'worker', 'reviewer', 'split', 'swap', 'abandon']
export type Outcome = 'pass' | 'round' | 'arbitrate' | 'split' | 'your-turn' | 'swap'

export interface Advice {
  outcome: Outcome
  why: string
  options: Choice[] // what the coordinator may choose; the user may choose any
  findings: string[] // the findings in question; a 'round' is limited to them
}

export interface AdviceInput {
  rounds: Round[] // every send-back of this step, oldest first; the last one is new
  nextGuarded?: boolean // the next step is a merge only the user may do
  extraUsed?: boolean // the one extra round was already given
  swapped?: boolean // the agent was already changed once
}

const ids = (fs: Finding[]) => fs.map(f => f.id)

// The after-N table. Rows are checked in order; the first that applies wins.
export function advise({ rounds, nextGuarded, extraUsed, swapped }: AdviceInput): Advice {
  const last = rounds.at(-1)?.findings ?? [], prev = rounds.at(-2)
  const left = blocking(last)
  const critical = left.filter(f => weight(f) === 'critical')
  if (critical.length || nextGuarded)
    return { outcome: 'your-turn', options: [], findings: ids(critical),
      why: critical.length ? `Critical with proof: ${critical.map(f => f.title).join('; ')}` : 'The next step is a merge only you may do' }
  if (!left.length) return { outcome: 'pass', options: ['pass'], findings: [], why: 'Nothing above minor is left' }
  const earlier = rounds.slice(0, -1)
  const seen = (id: string) => earlier.some(r => r.findings.some(f => f.id === id))
  const contested = left.filter(f => earlier.some(r => r.disputed?.includes(f.id) && r.findings.some(g => g.id === f.id)))
  if (contested.length)
    return { outcome: 'arbitrate', options: ['worker', 'reviewer'], findings: ids(contested),
      why: `Sent back again and contested by the agent: ${contested.map(f => f.title).join('; ')}` }
  const stuck = prev && blocking(prev.findings).every(f => left.some(g => g.id === f.id))
    && prev.diffLines !== undefined && (rounds.at(-1)!.diffLines ?? 0) > prev.diffLines
  if (stuck)
    return { outcome: 'swap', options: swapped ? ['abandon'] : ['swap', 'abandon'], findings: ids(left),
      why: swapped ? 'No progress again after a change of agent' : 'No finding fixed while the diff grows' }
  if (left.every(f => f.outOfScope))
    return { outcome: 'split', options: ['split'], findings: ids(left), why: 'The work is right; what is left belongs to another task' }
  const fresh = left.filter(f => !seen(f.id))
  if (fresh.length && !extraUsed)
    return { outcome: 'round', options: ['round', 'split'], findings: ids(fresh), why: `New finding: ${fresh.map(f => f.title).join('; ')}` }
  if (fresh.length) return { outcome: 'split', options: ['split'], findings: ids(fresh), why: 'A new finding after the extra round' }
  return { outcome: 'your-turn', options: [], findings: ids(left), why: 'The same findings are still open' }
}

const line = (f: Finding) => `- ${f.id} [${weight(f)}] ${f.title}${f.where ? ` (${f.where})` : ''}${f.proof ? `: ${f.proof}` : ''}`

// What the worker is told when a verdict sends the task back.
export const sendBackText = (step: string, fs: Finding[]) =>
  [`Step "${step}" sent it back:`, ...fs.map(line), 'Fix them, commit, then say you are done. If you contest one, say so with its id.'].join('\n')

// From the second round on, the reviewer checks only the points already found.
export function reviewText(text: string, prev?: Round) {
  if (!prev) return [text, REVIEW_FORMAT].filter(Boolean).join('\n\n')
  const contested = prev.disputed?.length ? [`The agent contests: ${prev.disputed.join(', ')}.`] : []
  const delta = prev.head ? [`Review only what came after the last round (${prev.head.slice(0, 7)}): list it with \`git log --oneline ${prev.head}..HEAD\`; for a merge of the base branch, \`git show --remerge-diff <commit>\` shows only how its conflicts were resolved; for any other commit, \`git show <commit>\`. What the base branch brought is not reviewed again.`] : []
  return [text, ...delta, 'Check only these findings of the last round; raise nothing new unless it is critical:', ...prev.findings.map(line), ...contested, REVIEW_FORMAT]
    .filter(Boolean).join('\n')
}
