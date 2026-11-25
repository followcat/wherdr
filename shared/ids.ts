// Multi-machine identifiers: a pane of a remote machine gets a "<machine>~"
// prefix; the local machine has none (links in notifications already sent,
// /#/a/w1:p1, stay valid).

export const LOCAL = ''
// Short key of a machine.
export const MACHINE_KEY_RE = /^[0-9a-f]{4,32}$/
export const SEP = '~'
// Pane : w1:p1 / s1:p1 (local) or 0a1b2c3d~w1:p1 / 0a1b2c3d~s1:p1 (remote).
export const PANE_RE = /^(?:[0-9a-f]{4,32}~)?[ws][0-9a-z]+:p[0-9a-z]+$/i

export function splitId(id: string): { machine: string, local: string } {
  const s = String(id || '')
  const i = s.indexOf(SEP)
  if (i < 0) return { machine: LOCAL, local: s }
  return { machine: s.slice(0, i), local: s.slice(i + 1) }
}

export const machineOf = (id: string | null | undefined) => splitId(String(id || '')).machine

// Letters NFKD does not split (sharp s, ae, oe, o slash, d bar, l slash, thorn).
const LIGATURES: Record<string, string> = { '\u00df': 'ss', '\u00e6': 'ae', '\u0153': 'oe', '\u00f8': 'o', '\u0111': 'd', '\u0142': 'l', '\u00fe': 'th' }

// Turns a typed name into a valid agent name instead of refusing it:
// "Agent portal project" -> "agent-portal-project". Accents dropped,
// other characters -> "-", repeated dashes merged, edge dashes removed,
// a letter added before a leading digit, cut to 32. Empty when nothing
// usable is left (only symbols).
export function toAgentName(raw: unknown): string {
  let s = String(raw ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
  s = s.replace(/[\u00df\u00e6\u0153\u00f8\u0111\u0142\u00fe]/g, c => LIGATURES[c]!)
  s = s.replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '')
  if (!s) return ''
  if (/^\d/.test(s)) s = `a-${s}`
  return s.slice(0, 32).replace(/[-_]+$/, '')
}
