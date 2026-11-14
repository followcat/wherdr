// `wherdr pm ui show file <path> | shots <task>`: an agent shows a file of its
// own folder, or a task's screenshots, beside its conversation (on a phone, a
// card that opens a sheet). It only shows: an approval goes through
// `ui action step` (shared/uiActions.ts). Pure: the arguments, the path check,
// the event (server/utils/uiOpen.ts sends it) and the block kept in the reply.
export type UiShowWhat = 'file' | 'shots'
export interface UiShowEvent { type: 'ui-show', pane: string, what: UiShowWhat, arg: string, by: string }

// A path inside the agent's folder, relative to it. An absolute path under
// cwd is made relative; ~, .., any other absolute path: null.
export function folderPath(raw: unknown, cwd?: string | null): string | null {
  if (typeof raw !== 'string') return null
  let p = raw.trim().replace(/^['"]|['"]$/g, '')
  const root = cwd?.replace(/\/+$/, '')
  if (root && p.startsWith(`${root}/`)) p = p.slice(root.length + 1)
  p = p.replace(/^(\.\/)+/, '')
  if (!p || p.length > 1024 || /^[/~]/.test(p) || /[\0\r\n]/.test(p) || p.split('/').includes('..')) return null
  return p
}

// `file <path…>` or `shots <task>` after `ui show`; bad: the usage error.
export type UiShowCommand = { name: 'ui show', what: 'file', path: string } | { name: 'ui show', what: 'shots', task: string }
export function uiShowArgs(what: string | undefined, rest: string[], taskRe: RegExp, bad: { error: string }): UiShowCommand | { error: string } {
  if (what === 'shots' && rest.length === 1 && taskRe.test(rest[0]!)) return { name: 'ui show', what, task: rest[0]! }
  if (what === 'file' && rest.length) return { name: 'ui show', what, path: rest.join(' ') }
  return bad
}

// The block an agent ends its reply with: the card, kept in the conversation.
export const showBlock = (what: UiShowWhat, arg: string) => `\`\`\`wherdr\nshow ${what} ${arg}\n\`\`\``
const SHOW_LINE = /^show\s+(file|shots)\s+(\S.*)$/
export function parseShowLine(line: string): { what: UiShowWhat, arg: string } | null {
  const m = SHOW_LINE.exec(line.trim())
  if (!m) return null
  const what = m[1] as UiShowWhat
  const arg = what === 'file' ? folderPath(m[2]) : m[2]!.trim()
  return arg && (what === 'file' || /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(arg)) ? { what, arg } : null
}

// What the card names: the file's name, or "Screenshots WHR-12".
export const showLabel = (e: Pick<UiShowEvent, 'what' | 'arg'>) =>
  e.what === 'shots' ? `Screenshots ${e.arg}` : e.arg.split('/').pop() || e.arg
