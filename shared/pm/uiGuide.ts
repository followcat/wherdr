// "Showing instead of telling": the one section of the role texts that teaches
// agents wherdr's chat tools, as a table of situations, each with the tool and
// a ready example. A coordinator gets it under "Links into wherdr" (docsRule in
// coordinator.ts), task agents a short version (instructionsText in run.ts).
// Alfred's is in docs/alfred.md, where its AGENTS.md points to it. Built from
// the tools' own lists (UI_TARGETS, UI_ACTIONS, the status kinds), so each role
// sees only what it may use and a removed tool leaves the text too.
// tests/uiGuide.test.ts parses every example, here and in the docs.
import { UI_ACTIONS, type UiAction } from '../uiActions'
import type { StatusKind } from '../statusBlock'
import type { UiTargetId } from '../uiTargets'
import { CHOICES_MAX, CHOICE_MAX_CHARS, QUESTIONS_MAX, QUESTION_CHOICES_MIN, QUESTION_MAX_CHARS } from '../wherdrBlockLimits'

// coordinator: `wherdr pm`; task: display blocks only (no ui token).
export type UiRole = 'coordinator' | 'task'
// A `wherdr` block, or a `wherdr pm` command (the words after `wherdr pm`).
export type UiExample = { block: string } | { argv: string[] }
export interface UiGuideRow { when: string, use: UiExample, not: string }

// The examples: a real target and status, so that they parse.
const TARGET: UiTargetId = 'terminal.key-order'
const STATUS: StatusKind = 'machine'
const CARD_LIMITS = `Limits: an option up to ${CHOICE_MAX_CHARS} characters, a question up to ${QUESTION_MAX_CHARS}, ${QUESTION_CHOICES_MIN} to ${CHOICES_MAX} options per question, at most ${QUESTIONS_MAX} questions; one line over a limit and the whole block shows as plain code.`

// Each action's row (a new action in UI_ACTIONS must say when to use it).
const ACTION_ROWS: Record<UiAction, (task: string) => UiGuideRow> = {
  step: task => ({ when: 'A step waits for the user (merge, approve screenshots)', use: { argv: ['ui', 'action', 'step', task] }, not: '"you can merge it now"' }),
  resume: task => ({ when: 'The user wants a stopped task to go on', use: { argv: ['ui', 'action', 'resume', task] }, not: 'resuming it yourself' }),
  open: task => ({ when: 'The user should look at a task\'s sheet', use: { argv: ['ui', 'action', 'open', task] }, not: 'a sentence describing where to click' }),
}

// key: a task key for the examples.
export function uiGuideRows(role: UiRole, o: { key?: string } = {}): UiGuideRow[] {
  const task = `${o.key || 'ABC'}-12`
  const blocks: UiGuideRow[] = [
    { when: `You need one choice among 2 to ${CHOICES_MAX}`, use: { block: 'choices "Squash" | "Merge commit" | "Rebase"' }, not: 'a numbered list ("reply 1, 2 or 3")' },
    { when: `You need several answers at once (2 to ${QUESTIONS_MAX} questions, ${QUESTION_CHOICES_MIN} to ${CHOICES_MAX} options each)`, use: { block: 'questions\n1 "Which database?" | "Postgres" | "SQLite"\n2 "Keep the old API?" | "Yes" | "No, remove it"' }, not: 'a numbered list of questions, or one message per question' },
    { when: 'You need a yes to one proposal', use: { block: 'choices "OK, fix the test"' }, not: '"reply OK to go on"' },
    { when: 'You name a task whose state matters', use: { block: `task ${task}` }, not: 'its state copied in a sentence (a bare id in passing is fine)' },
  ]
  if (role === 'task') return blocks
  return [
    { when: 'The user asks where a setting is, or one would solve their problem', use: { argv: ['ui', 'open', '--target', TARGET] }, not: '"go to Settings › Terminal" alone' },
    ...blocks,
    { when: 'How a machine, a quota, a PR or an operation is doing', use: { block: `status ${STATUS}:laptop` }, not: 'numbers copied from a command (they go stale)' },
    ...UI_ACTIONS.map(a => ACTION_ROWS[a](task)),
    { when: 'A task\'s screenshots to look at', use: { argv: ['ui', 'show', 'shots', task] }, not: 'pasting a path or describing the images' },
  ]
}

const quoted = (w: string) => (/^[\w.:/@=-]+$/.test(w) ? w : `'${w.replace(/'/g, '\'\\\'\'')}'`)
// A block's example goes below the table, as a fenced block to copy as is: in a
// table cell its | would need escaping (choices), and the copy would not parse.
const kind = (b: string) => b.split(/\s/)[0]
const useText = (u: UiExample) => ('block' in u
  ? `a \`${kind(u.block)}\` line in a \`wherdr\` block (example below)`
  : `\`wherdr pm ${u.argv.map(quoted).join(' ')}\``)

export function uiGuide(role: UiRole, o: { key?: string } = {}): string[] {
  const rows = uiGuideRows(role, o)
  const table = ['| When | Use | Not |', '|---|---|---|', ...rows.map(r => `| ${r.when} | ${useText(r.use)} | ${r.not} |`)]
  const blocks = rows.flatMap(r => ('block' in r.use ? ['```wherdr', r.use.block, '```', ''] : []))
  const examples = ['Examples, one block each:', '', ...blocks]
  if (role === 'task') {
    return ['## Showing instead of telling', '',
      'When you ask the user something, the chat can draw it: a fenced code block in the language `wherdr`, one line per element. You have no `ui` command: these blocks only show.', '',
      ...table, '', ...examples,
      `Choices only in a question you are blocked on. One block per message, after the sentence that explains it. ${CARD_LIMITS} The user answers a \`questions\` card in one message, one line per question: \`1A Postgres\`, \`2B No, remove it\`, \`3 <their own words>\` or \`3 skip\`.`, '']
  }
  return ['## Showing instead of telling', '',
    'Show the user what you mean instead of describing it. A `wherdr` block is a fenced code block in the language `wherdr`, one line per element, one kind per block: the chat draws it with live data (never what you wrote about it).', '',
    ...table, '', ...examples,
    `- At most one card or button group per message, after the sentence that explains it; never a card with no sentence. ${CARD_LIMITS} Several questions go in one \`questions\` card, answered in one message, one line per question: \`1A Postgres\`, \`2B No, remove it\`, \`3 <their own words>\` or \`3 skip\`.`,
    '- In a wake: `wherdr` blocks only. A `ui` command or `--propose` is refused there: tell the user what you would show instead of trying.',
    '- A refusal (no open wherdr: `not_found`, or not in the user\'s turn) → give the in-app link in text. Never retry in a loop.',
    '- Only the user\'s click acts: never say a button\'s action is done ("I merged it") before its card shows the outcome.', '']
}
