// "Showing instead of telling": the one section of the role texts that teaches
// agents wherdr's chat tools, as a table of situations, each with the tool and
// a ready example. Alfred and the coordinators get it under "Links into
// wherdr" (docsRule in coordinator.ts), task agents a short version
// (instructionsText in run.ts). Built from the tools' own lists (UI_TARGETS,
// UI_ACTIONS, the status kinds), so each role sees only what it may use and a
// removed tool leaves the text too. tests/uiGuide.test.ts parses every example.
import { UI_ACTIONS, type UiAction } from '../uiActions'
import type { StatusKind } from '../statusBlock'
import type { UiTargetId } from '../uiTargets'

// alfred: `wherdr alfred` (and `wherdr pm` when project management is on);
// coordinator: `wherdr pm`; task: display blocks only (no ui token).
export type UiRole = 'alfred' | 'coordinator' | 'task'
export type UiExample = { block: string } | { cli: 'alfred' | 'pm', argv: string[] }
export interface UiGuideRow { when: string, use: UiExample, not: string }

// The examples: a real target, setting and statuses, so that they parse.
const TARGET: UiTargetId = 'terminal.key-order'
const STATUS: StatusKind = 'machine'

// Each action's row (a new action in UI_ACTIONS must say when to use it).
const ACTION_ROWS: Record<UiAction, (task: string) => UiGuideRow> = {
  step: task => ({ when: 'A step waits for the user (merge, approve screenshots)', use: { cli: 'pm', argv: ['ui', 'action', 'step', task] }, not: '"you can merge it now"' }),
  resume: task => ({ when: 'The user wants a stopped task to go on', use: { cli: 'pm', argv: ['ui', 'action', 'resume', task] }, not: 'resuming it yourself' }),
  open: task => ({ when: 'The user should look at a task\'s sheet', use: { cli: 'pm', argv: ['ui', 'action', 'open', task] }, not: 'a sentence describing where to click' }),
}

// pm: the role has `wherdr pm` (always for a coordinator, for Alfred when
// project management is on). key: a task key for the examples.
export function uiGuideRows(role: UiRole, o: { pm?: boolean, key?: string } = {}): UiGuideRow[] {
  const task = `${o.key || 'ABC'}-12`
  const blocks: UiGuideRow[] = [
    { when: 'You need one choice among 2 to 4', use: { block: 'choices "Squash" | "Merge commit" | "Rebase"' }, not: 'a numbered list ("reply 1, 2 or 3")' },
    { when: 'You need a yes to one proposal', use: { block: 'choices "OK, fix the test"' }, not: '"reply OK to go on"' },
    { when: 'You name a task whose state matters', use: { block: `task ${task}` }, not: 'its state copied in a sentence (a bare id in passing is fine)' },
  ]
  if (role === 'task') return blocks
  const cli = role === 'alfred' ? 'alfred' : 'pm'
  const pm = role === 'coordinator' || !!o.pm
  return [
    { when: 'The user asks where a setting is, or one would solve their problem', use: { cli, argv: ['ui', 'open', '--target', TARGET] }, not: '"go to Settings › Terminal" alone' },
    ...(role === 'alfred' ? [{ when: 'A setting change would help', use: { cli: 'alfred', argv: ['setting', 'set', 'replyStyle', 'list', '--propose'] }, not: 'asking "shall I?" and changing it yourself' } as UiGuideRow] : []),
    ...(role === 'alfred' && pm ? [{ when: 'A project change the user wants (add, template, guards, coordinator)', use: { cli: 'alfred', argv: ['project', 'guards', o.key || 'ABC', '--merge-protected', 'user', '--propose'] }, not: 'a yes in text, then --apply' } as UiGuideRow] : []),
    ...blocks,
    { when: 'How a machine, a quota, a PR or an operation is doing', use: { block: `status ${STATUS}:laptop` }, not: 'numbers copied from a command (they go stale)' },
    ...(pm ? UI_ACTIONS.map(a => ACTION_ROWS[a](task)) : []),
    ...(pm ? [{ when: 'A task\'s screenshots to look at', use: { cli: 'pm', argv: ['ui', 'show', 'shots', task] }, not: 'pasting a path or describing the images' } as UiGuideRow] : []),
  ]
}

const quoted = (w: string) => (/^[\w.:/@=-]+$/.test(w) ? w : `'${w.replace(/'/g, '\'\\\'\'')}'`)
// A block's example goes below the table, as a fenced block to copy as is: in a
// table cell its | would need escaping (choices), and the copy would not parse.
const kind = (b: string) => b.split(' ')[0]
const useText = (u: UiExample) => ('block' in u
  ? `a \`${kind(u.block)}\` line in a \`wherdr\` block (example below)`
  : `\`wherdr ${u.cli} ${u.argv.map(quoted).join(' ')}\``)

export function uiGuide(role: UiRole, o: { pm?: boolean, key?: string } = {}): string[] {
  const rows = uiGuideRows(role, o)
  const table = ['| When | Use | Not |', '|---|---|---|', ...rows.map(r => `| ${r.when} | ${useText(r.use)} | ${r.not} |`)]
  const blocks = rows.flatMap(r => ('block' in r.use ? ['```wherdr', r.use.block, '```', ''] : []))
  const examples = ['Examples, one block each:', '', ...blocks]
  if (role === 'task') {
    return ['## Showing instead of telling', '',
      'When you ask the user something, the chat can draw it: a fenced code block in the language `wherdr`, one line per element. You have no `ui` command: these blocks only show.', '',
      ...table, '', ...examples,
      'Choices only in a question you are blocked on. One block per message, after the sentence that explains it.', '']
  }
  return ['## Showing instead of telling', '',
    'Show the user what you mean instead of describing it. A `wherdr` block is a fenced code block in the language `wherdr`, one line per element, one kind per block: the chat draws it with live data (never what you wrote about it).', '',
    ...table, '', ...examples,
    '- At most one card or button group per message, after the sentence that explains it; never a card with no sentence.',
    '- In a wake: `wherdr` blocks only. A `ui` command or `--propose` is refused there: tell the user what you would show instead of trying.',
    '- A refusal (no open wherdr: `not_found`, or not in the user\'s turn) → give the in-app link in text. Never retry in a loop.',
    '- Only the user\'s click acts: never say a button\'s action is done ("I merged it") before its card shows the outcome.', '']
}
