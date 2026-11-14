// What a task's agent last said, on whichever machine it runs: the last
// message of its conversation (read through herdr-core, a remote machine's
// disk included), else the bottom of its terminal screen. For `wherdr pm read`
// and the "agent asks a question" wake.
import type { ChatItem } from '../../shared/types'
import type { CoreAdminDeps } from './coreCreate'

export const READ_LINES = 40

const tail = (s: string, lines: number) => s.split('\n').slice(-lines).join('\n')

// The agent's last message with text, its last `lines` lines.
export function lastMessage(items: ChatItem[] | null | undefined, lines: number) {
  const it = [...(items ?? [])].reverse().find(x => x.role === 'assistant' && x.text.trim())
  return it ? { text: tail(it.text.trim(), lines), at: it.ts } : undefined
}

type Deps = Pick<CoreAdminDeps, 'call' | 'panes' | 'chat'>
async function fromConversation(deps: Deps, terminal: string, lines: number) {
  const pane = deps.chat && deps.panes().find(p => p.coreAddress === terminal)
  return pane ? lastMessage(await deps.chat!(pane).catch(() => null), lines) : undefined
}

export type LastWords = { from: 'conversation' | 'screen', text: string, at?: string | null }

export async function lastWords(deps: Deps, terminal: string, lines = READ_LINES): Promise<LastWords | null> {
  const said = await fromConversation(deps, terminal, lines)
  if (said) return { from: 'conversation', ...said }
  const screen = (await deps.call<{ text?: string }>('terminal.read', { terminal, lines }, 4000).catch(() => null))?.text?.replace(/\s+$/, '')
  return screen ? { from: 'screen', text: tail(screen, lines) } : null
}

// The question for the task's waiting line and its wake: one line, its end
// kept (where the question is), from the conversation only (a screen is no
// sentence); and the whole message, for Tasks to review. Only a huge one is
// cut, in its middle: its start and its end (the question, its choices) stay.
export const QUESTION_MAX = 100_000
export const wholeQuestion = (text: string) =>
  text.length > QUESTION_MAX ? `${text.slice(0, QUESTION_MAX / 2)}\n\n[…]\n\n${text.slice(-QUESTION_MAX / 2)}` : text
export async function askedQuestion(deps: Deps, terminal: string) {
  const said = await fromConversation(deps, terminal, Infinity)
  const line = said?.text.replace(/\s+/g, ' ').trim()
  return line ? { line: line.length > 500 ? `…${line.slice(-499)}` : line, full: wholeQuestion(said!.text) } : undefined
}
