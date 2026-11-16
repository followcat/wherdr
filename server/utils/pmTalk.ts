// The user's conversations with agents, by terminal address, in memory (a
// restart forgets them): when they last wrote to each, from the chat or its
// terminal, and which they have open in wherdr (a chat polled within
// CHAT_OPEN_MS, or a terminal stream). The release of a task's agents reads it
// (pmRelease.ts, Talk in shared/pm/release.ts).
import type { Talk } from '../../shared/pm/release'

const CHAT_OPEN_MS = 60_000
const said = new Map<string, number>()
const polled = new Map<string, number>()
const streams = new Map<string, number>()

export const userWrote = (terminal?: string, now = Date.now()) => { if (terminal) said.set(terminal, now) }
export const chatPolled = (terminal?: string, now = Date.now()) => { if (terminal) polled.set(terminal, now) }
// A terminal stream opened (+1) or closed (-1).
export function streamOpen(terminal: string | undefined, d: 1 | -1) {
  if (!terminal) return
  const n = (streams.get(terminal) ?? 0) + d
  if (n > 0) streams.set(terminal, n)
  else streams.delete(terminal)
}

export function talkOf(terminals: (string | undefined)[], now = Date.now()): Talk {
  const ts = terminals.filter((t): t is string => !!t)
  const at = Math.max(0, ...ts.map(t => said.get(t) ?? 0)) || undefined
  const open = ts.some(t => streams.has(t) || now - (polled.get(t) ?? -Infinity) < CHAT_OPEN_MS)
  return { ...(at ? { at } : {}), ...(open ? { open } : {}) }
}

export function forgetTalk(terminal: string) {
  said.delete(terminal)
  polled.delete(terminal)
  streams.delete(terminal)
}
