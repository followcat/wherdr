// Escape stops a working agent only when pressed twice within ESC_CONFIRM_MS.
// One stray Escape (a dictation app closing its popup, a window switch) used
// to stop the agent's work: the page cannot tell such a key from the user's,
// a second press can. The Stop button still acts on one click.
export const ESC_CONFIRM_MS = 1500

export interface EscapeArm { at: number | null }

// true: this press is the second one, the agent stops. false: the first one,
// it only arms (a hint asks for a second press).
export function pressEscape(arm: EscapeArm, now: number): boolean {
  const confirm = arm.at !== null && now - arm.at >= 0 && now - arm.at < ESC_CONFIRM_MS
  arm.at = confirm ? null : now
  return confirm
}
