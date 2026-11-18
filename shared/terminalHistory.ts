// Retained history a terminal attach asks the core for (server/utils/coreTerm.ts).
//
// A cold open asks for a few screens only: the attach's paint is downloaded and
// replayed on every open, so the deep history is fetched on demand, when the
// person scrolls back to the top (`terminal.history` on the same socket).
export const COLD_HISTORY = 200

// The most a viewer may ask for: xterm's scrollback (CORE_SCROLLBACK) and this
// ceiling are the same, so a deep paint never delivers rows xterm would drop.
export const MAX_HISTORY = 5000

// Lines of a `terminal.history` request, clamped to what a viewer may hold.
// `null`: not a history request (missing, not a number, negative).
export function clampHistoryLines(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(MAX_HISTORY, Math.floor(n))
}
