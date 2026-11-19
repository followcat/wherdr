// A feature's plan file (docs/workspaces.md#features): the tasks.md of a spec,
// with checkbox lines that have stable IDs (`- [ ] T012 [P] Write the tests`).
// A sub-task names the lines it covers (`refs`); the engine ticks them once the
// sub-task is done. Everything here is pure: the machine's side is
// server/utils/pmPlan.ts.
import { commitMessageFor } from './branchName'
import type { Task } from './run'

// An ID as spec-kit writes it: T012, US3, FR-12.
export const REF_RE = /^[A-Za-z][A-Za-z0-9-]*\d+$/
export const REFS_MAX = 50

// A task's refs from a list or a comma-separated text (--refs T1,T2): each ID
// once, in order, or why not.
export function parseRefs(v: unknown): string[] | { error: string } {
  const list = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : v === undefined ? [] : null
  if (!list || list.some(x => typeof x !== 'string')) return { error: 'refs are plan line IDs: T010,T011' }
  const refs = [...new Set((list as string[]).map(x => x.trim()).filter(Boolean))]
  const bad = refs.find(r => r.length > 40 || !REF_RE.test(r))
  if (bad) return { error: `${bad.slice(0, 40)} is not a plan line ID (letters, digits and dashes, ending in a number: T012)` }
  return refs.length > REFS_MAX ? { error: `refs: ${REFS_MAX} at most` } : refs
}

// The plan file's path under the workspace's root, kept as the feature's `plan`:
// relative, never leaving the root, never inside .git. (The machine's real
// path, symlinks resolved, is checked again when the file is read or written.)
export function parsePlanPath(raw: unknown): string | { error: string } {
  const s = typeof raw === 'string' ? raw.trim().replace(/^(\.\/)+/, '') : ''
  const parts = s.split('/')
  if (!s || s.length > 300 || /[\x00-\x1f]/.test(s) || s.startsWith('/') || s.startsWith('~') || parts.some(x => !x || x === '..' || x === '.' || x === '.git'))
    return { error: 'plan: the path of the plan file under the workspace\'s root, such as specs/018-export/tasks.md' }
  return s
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// An ID ends where no ID character follows: T1 is not T10 nor T1-2.
const END = '(?![A-Za-z0-9-])'
const OPEN = new RegExp(`^\\s*[-*+] \\[ \\] ([A-Za-z][A-Za-z0-9-]*\\d+)${END}`)

// The lines inside a fenced code block (``` or ~~~, the fences included): an example, never a plan line.
function fenced(lines: string[]): boolean[] {
  let fence = ''
  return lines.map((l) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l)
    if (!fence) { if (m) fence = m[1]!; return !!m }
    if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && !l.trim().slice(m[1]!.length).trim()) fence = ''
    return true
  })
}

export type Skipped = { ref: string, why: 'already ticked' | 'not found' }
export interface Done { task: string, date: string, sha?: string }

// The plan with each ref's first open line ticked (`- [ ] T012 …` → `- [x] T012 … (done: PA-1, 1a2b3c4, 2026-11-17)`),
// notes and line endings kept. A line already ticked, or none: left as it is and
// named in skipped. Ticking twice changes nothing the second time.
export function tickPlan(text: string, refs: string[], done: Done): { text: string, ticked: string[], skipped: Skipped[] } {
  const lines = text.split('\n'), skip = fenced(lines), ticked: string[] = [], skipped: Skipped[] = []
  const note = ` (done: ${[done.task, done.sha, done.date].filter(Boolean).join(', ')})`
  for (const ref of refs) {
    const open = new RegExp(`^(\\s*[-*+] )\\[ \\] ${escape(ref)}${END}`)
    const i = lines.findIndex((l, n) => !skip[n] && open.test(l))
    if (i < 0) {
      const was = new RegExp(`^\\s*[-*+] \\[[xX]\\] ${escape(ref)}${END}`)
      skipped.push({ ref, why: lines.some((l, n) => !skip[n] && was.test(l)) ? 'already ticked' : 'not found' })
      continue
    }
    const line = lines[i]!, head = open.exec(line)![1]!, cr = line.endsWith('\r') ? '\r' : ''
    lines[i] = `${head}[x]${line.slice(head.length + 3, line.length - cr.length)}${note}${cr}`
    ticked.push(ref)
  }
  return { text: lines.join('\n'), ticked, skipped }
}

// The log line for refs not ticked.
export const skippedText = (skipped: Skipped[]) => skipped.map(s => `plan: ${s.ref} not ticked (${s.why})`).join('; ')

// The lines still open (`- [ ] T012 …`), each as its ID and its text (the first 80 characters after the box).
export function openLines(text: string): { id: string, text: string }[] {
  const all = text.split('\n'), skip = fenced(all)
  return all.flatMap((l, n) => {
    const m = skip[n] ? null : OPEN.exec(l)
    return m ? [{ id: m[1]!, text: l.replace(/^\s*[-*+] \[ \] /, '').trimEnd().slice(0, 80) }] : []
  })
}

// Why the feature may not close with open lines in its plan: those lines, up to 12 of them.
export function planCloseRefusal(file: string, open: { id: string, text: string }[]): string | undefined {
  if (!open.length) return undefined
  const shown = open.slice(0, 12).map(l => `${l.text}`).join('; ')
  return `${open.length} line${open.length === 1 ? '' : 's'} of ${file} still unticked: ${shown}${open.length > 12 ? `; and ${open.length - 12} more` : ''}. Ask the user, then close with --anyway`
}

// The commit message of a tick: the workspace's commit message template when it
// has one ({tag} and {id} from the sub-task, {title} says what was ticked), else
// "<feature>: tick <refs> (<task>)". Ids as the user sees them.
export function planCommitMessage(tpl: string | undefined, feature: string, task: Pick<Task, 'id' | 'title' | 'type' | 'tags'>, refs: string[]): string {
  const ticked = refs.join(', ')
  return commitMessageFor(tpl, { ...task, title: `tick ${ticked} (${task.title})` }) ?? `${feature}: tick ${ticked} (${task.id})`
}
