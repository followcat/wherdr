import fs from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, HERDR_BIN } from './env'
import { getMachine, RemoteMachine } from './machines'
import { HerdrError } from './herdr'

export const SPLIT_TERMINAL_TOKEN = 'wherdr_split_terminal'
export const SPLIT_PROMPT_TOKEN = 'wherdr_split_prompt'
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// These hooks attest to a prompt, rather than guessing from foreground PIDs.
// PS0/preexec clear the attestation before builtins as well as child processes.
export function splitShellHooks(binary: string, session: string) {
  const report = `${quote(binary)} --session ${quote(session)} pane report-metadata "$HERDR_PANE_ID" --source wherdr-split`
  const busy = `${report} --clear-token ${SPLIT_PROMPT_TOKEN} >/dev/null 2>&1`
  const ready = `${report} --token "${SPLIT_PROMPT_TOKEN}=$$" >/dev/null 2>&1`
  return {
    bash: `if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then PS0=${quote(`$(${busy})`)}; ${ready}; fi`,
    zsh: `_wherdr_split_busy() { ${busy}; }\n_wherdr_split_ready() { ${ready}; }\npreexec_functions+=(_wherdr_split_busy)\nprecmd_functions+=(_wherdr_split_ready)\n`,
  }
}

export async function prepareSplitShell(machine: string): Promise<Record<string, string>> {
  const m = getMachine(machine)
  if (!m) throw new HerdrError('bad_machine', 'Unknown machine')
  const dir = m.local ? path.join(DATA_DIR, 'split-shell') : path.posix.join(m.home, '.cache/herdr-web/split-shell')
  const hooks = splitShellHooks(m instanceof RemoteMachine ? m.bin : HERDR_BIN, m.session)
  // Keep the user's startup files and hooks. Only this new pane uses our
  // ZDOTDIR; no user configuration is written or edited.
  const zshenv = 'unset ZDOTDIR\n[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"\nexport WHERDR_SPLIT_USER_ZDOTDIR=${ZDOTDIR:-$HOME}\nexport ZDOTDIR=$WHERDR_SPLIT_BOOTSTRAP\n'
  const zprofile = 'ZDOTDIR=$WHERDR_SPLIT_USER_ZDOTDIR\n[[ -f "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"\nexport WHERDR_SPLIT_USER_ZDOTDIR=${ZDOTDIR:-$HOME}\nexport ZDOTDIR=$WHERDR_SPLIT_BOOTSTRAP\n'
  const zshrc = 'ZDOTDIR=$WHERDR_SPLIT_USER_ZDOTDIR\n[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"\n' + hooks.zsh
  if (m.exec) {
    const r = await m.exec('umask 077; mkdir -p "$1" && printf %s "$2" > "$1/.zshenv" && printf %s "$3" > "$1/.zshrc" && printf %s "$4" > "$1/.zprofile"', [dir, zshenv, zshrc, zprofile], { timeoutMs: 5000 })
    if (r.code !== 0) throw new HerdrError('split_failed', 'Could not prepare the split terminal. No command was sent.')
  } else {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(dir, '.zshenv'), zshenv, { mode: 0o600 })
    await fs.writeFile(path.join(dir, '.zshrc'), zshrc, { mode: 0o600 })
    await fs.writeFile(path.join(dir, '.zprofile'), zprofile, { mode: 0o600 })
  }
  return { PROMPT_COMMAND: hooks.bash, ZDOTDIR: dir, WHERDR_SPLIT_BOOTSTRAP: dir }
}
