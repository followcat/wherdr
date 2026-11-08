// The PATH the user expects agent programs on: the bin/ of the nvm version the
// default alias names (or of the newest installed version when there is no
// usable alias), then the usual user install folders, then the PATH the
// machine gave. Started as a service, the core's own PATH has only the system
// folders: without this, agents installed under nvm (claude, codex…) or as
// OpenCode are neither listed nor found at launch.
// One snippet for both the availability probe below and the launch line
// (PATH_SETUP in coreCreate.ts), so detection and launch can never disagree.
// Plain POSIX sh: no login or interactive shell, whose banners would pollute
// the probe's stdout.
export const USER_PATH_SETUP =
  `wd=; wv=; [ -r "$HOME/.nvm/alias/default" ] && read -r wv < "$HOME/.nvm/alias/default"; ` +
  `case "$wv" in v[0-9.]*) ;; [0-9.]*) wv="v$wv" ;; *) wv= ;; esac; ` +
  `[ -n "$wv" ] && [ -d "$HOME/.nvm/versions/node/$wv/bin" ] && wd="$HOME/.nvm/versions/node/$wv/bin"; ` +
  `if [ -z "$wd" ]; then wv=$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sed -n 's/^v\\([0-9][0-9.]*\\)$/\\1/p' | LC_ALL=C sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1); ` +
  `[ -n "$wv" ] && wd="$HOME/.nvm/versions/node/v$wv/bin"; fi; ` +
  `PATH="\${wd:+$wd:}$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.kimi-code/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ` +
  `export PATH; unset wd wv`

// Prints each given command found on the machine (shell script, commands as arguments).
export const KIND_PROBE_SCRIPT = USER_PATH_SETUP + `
for cmd do command -v "$cmd" >/dev/null 2>&1 && printf '%s\\n' "$cmd"; done; exit 0`
