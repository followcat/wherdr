// The TL;DR under To do: a few lines for the user to decide, written by a cheap
// model (Haiku) from the task's title, description, reports and verdicts, the
// files it changed with their line counts (no contents) and its step; not what
// its Merge does (the step's badge says it). Written again only on a significant
// change: a new prompt version, new commits of its own (not a merge of the
// base, a rebase or a CI re-run), new findings, or a first verdict on them. Everything that goes out is masked.
import { taskHistory, REPORTS } from './history'
import { maskLeaks } from './visibility'
import type { PlannedStep, StepState } from './steps'
import type { Task } from './run'

// key: what the TL;DR was written for (tldrSource).
export interface TaskTldr { key: string, text: string, at: number }

const INPUT_MAX = 12_000
const WHO = { worker: 'Worker', reviewer: 'Reviewer', user: 'User', coordinator: 'Coordinator', engine: 'wherdr' } as const

// The prompt's version, the first part of every key: a new one writes every
// open task's TL;DR again, once.
export const TLDR_VERSION = 'v2'

export const TLDR_PROMPT = [
  'Write a TL;DR of this software task for its owner, who is not a developer and must decide on it in 10 seconds (merge it or send it back).',
  'Plain words, in English, at most 5 lines of plain Markdown, each line a "- " bullet:',
  '"**What changes for you:**" then 1 to 3 short lines on what they will see or what now behaves differently;',
  '"**What to look at:**" one line, only when the reports mention screenshots: what to check on them;',
  '"**Anything wrong:**" one line, only when there is a real reason to hesitate: a review finding left open, a check that failed, something the worker could not do.',
  'Never name a file, function, class, component, test, command or tool, and no code formatting.',
  'Leave out how it was checked, test counts, failures that were there before the change, tooling details, and what merging does or where it goes.',
  'Use only the text below. No heading, no preamble.',
  '\n\nGood:\n- **What changes for you:** the setup window fits a phone screen; long project names wrap instead of pushing the buttons out.\n- **What to look at:** on the phone screenshot, the Save button is fully visible.',
  '\n\nBad (code names, test counts, how it was checked, the merge):\n- Fixed `SetupWindow.vue` overflow, `scrollWidth == clientWidth` checked, `nuxt typecheck` passes.\n- 34 failures in other tests predate it.\n- Merge squashes the PR into v3.',
].join(' ')

type Source = Pick<Task, 'title' | 'description' | 'log' | 'work' | 'workReports'> & { step?: StepState }

// The key of what the TL;DR says (its own commits, the findings, whether a
// verdict read those commits: not who wrote last, so a report that changes no
// code, a PR opened, keeps it) and the text the model reads; null: no report or verdict yet.
export function tldrSource(task: Source, plan: PlannedStep[]): { key: string, last: number, input: string } | null {
  const entries = taskHistory(task.log ?? [], plan, task.step, false, task.workReports).filter(e => REPORTS.has(e.label))
  if (!entries.length) return null
  const s = task.step
  const findings = [...Object.values(s?.reviews ?? {}).flat().flatMap(r => r.findings), ...Object.values(s?.minor ?? {}).flat()].map(f => f.id).sort()
  const w = task.work, key = [TLDR_VERSION, w?.commits ?? '', findings.join(','), w?.reviewed && w.reviewed === w.commits ? 'reviewed' : ''].join('|')
  const files = task.work?.files ?? []
  const head = [
    `Task: ${task.title}`,
    `Step: ${s?.done ? 'done' : plan[s?.at ?? 0]?.id ?? '?'}`,
    task.description ? `## Description\n\n${task.description.slice(0, 2000)}` : '',
    files.length ? `## Changed files\n\n${files.slice(0, 60).map(f => `- ${f.path} +${f.add} -${f.del}`).join('\n')}${files.length > 60 ? `\n- … ${files.length - 60} more` : ''}` : '',
  ].filter(Boolean).join('\n\n')
  // The newest reports kept when it is too long.
  const reports = entries.map(e => `## ${WHO[e.who]}: ${e.label}\n\n${e.text}`).join('\n\n')
  const room = Math.max(INPUT_MAX - head.length, 2000)
  return { key, last: entries.at(-1)!.at, input: maskLeaks(`${head}\n\n${reports.length > room ? reports.slice(-room) : reports}`) }
}

export const tldrPrompt = (input: string) => `${TLDR_PROMPT}\n\n---\n\n${input}`

// The model's answer, kept short: at most 5 lines, 700 characters, no code formatting.
export const cleanTldr = (out: string) =>
  out.replaceAll('`', '').trim().split('\n').filter(l => l.trim()).slice(0, 5).join('\n').slice(0, 700).trim()

// An agent's question (Tasks to review): its last message in 2 or 3 plain
// lines, written again only when the question changes (its key). The whole
// message shows under it, and alone while the pace holds this one.
export const QUESTION_VERSION = 'q1'
export const QUESTION_PROMPT = [
  'An AI agent working on a software task stopped to ask its owner a question. Its owner is not a developer and must answer in 10 seconds.',
  'In plain words, in English, at most 3 short lines of plain Markdown, no heading, no preamble: what the agent asks, why it cannot go on without the answer, and what each option means for the owner (when it gives options).',
  'Never name a file, path, function, class, component, test, command or tool, and no code formatting. Use only the text below.',
  '\n\nGood: The agent needs the test server running to check its change. It asks whether to wait while you start it, to write the change without checking it, or to stop here.',
  '\n\nBad: Run `docker compose up` in ~/project so `npm test` passes, or pick choices "Write it without testing".',
].join(' ')

// The question's key: the prompt's version and the message's hash (FNV-1a).
export function questionKey(text: string) {
  let h = 0x811C9DC5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return `${QUESTION_VERSION}|${text.length}|${(h >>> 0).toString(36)}`
}
export const questionPrompt = (title: string, question: string) =>
  `${QUESTION_PROMPT}\n\n---\n\nTask: ${title}\n\n## The agent's message\n\n${maskLeaks(question.slice(-INPUT_MAX))}`
