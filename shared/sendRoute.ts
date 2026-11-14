// How a message reaches an agent (app/composables/useActions.ts sendMessage).
import type { Pane } from './types'

// true: /api/prompt — sent as a message, or held by the server until the
// agent's input field is back. false: /api/input — typed as is, followed by
// Enter, as the answer to the question on screen.
// Blocked on a question: the text is its typed answer. Blocked on a menu or a
// screen with no question (/mcp…): typed now it would be lost in it; held.
// omp: only its free-answer field takes typed text; its select dialog (tool
// approval) or "Ask" list would lose it, and Enter would answer them in the
// user's place.
// Codex stopped by its update, or just gone (`leaving`): a shell. The server
// holds the message; typed with Enter it would run as a command. Codex
// installing or updating itself: held too, until it is ready.
export function viaPrompt(p: Pick<Pane, 'agent' | 'status' | 'prompt' | 'stopped' | 'leaving' | 'installing'> | undefined): boolean {
  if (p?.stopped || p?.leaving || p?.installing || p?.prompt?.kind === 'self-update') return true
  if (!p || !p.agent) return false
  if (p.status !== 'blocked') return true
  if (p.agent === 'omp') return !p.prompt?.typing
  return !p.prompt && (p.agent === 'claude' || p.agent === 'codex')
}
