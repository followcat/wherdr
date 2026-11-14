// How wherdr starts Codex. Its update check at startup is off (Codex's own
// `check_for_update_on_startup` key, passed with -c: ~/.codex stays untouched),
// so that an update never ends a fresh conversation.
export const CODEX_NO_UPDATE = ['-c', 'check_for_update_on_startup=false']

// Set on a Codex terminal when Codex exited after its own version changed
// (it updated itself anyway): the terminal stays open as a shell and the
// conversation offers to restart Codex (see shared/coreState.ts).
export const CODEX_UPDATED_LABEL = 'wherdr.codex-updated'

export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// The shell line that runs `codex <args>`: a plain exit ends the terminal as
// before; an exit with a new Codex version leaves the label and a plain sh
// (whatever the user's shell, so that the restart line is always sh's).
export function codexLine(args: string[]): string {
  return `v=$(codex --version 2>/dev/null); ${['codex', ...CODEX_NO_UPDATE, ...args].map(quote).join(' ')}; s=$?; `
    + `if [ "$(codex --version 2>/dev/null)" != "$v" ]; then hc label "$HC_TERMINAL_ID" ${CODEX_UPDATED_LABEL}=1 >/dev/null 2>&1; exec sh -i; fi; exit $s`
}

// Codex's screen or title while it installs or updates itself: not ready for a message.
export const codexInstalling = (...texts: (string | null | undefined)[]) =>
  texts.some(t => /\b(?:installing|updating)\s+codex\b/i.test(t || ''))
