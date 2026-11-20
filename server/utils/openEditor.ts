// "Open in editor" (Mod+Alt+O): the agent's folder in the default editor of the
// machine the agent runs on (local, or over core's machine.exec), macOS only.
//
// Safeguards: only a pane the app knows; the folder is the pane's own folder
// (the client sends no path); it must exist and, once symlinks are resolved on
// the machine, lie under that machine's home; the folder only travels as a
// positional argument ($1), never as shell text; nothing but `open` runs.
import { execFile } from 'node:child_process'
import { HerdrError } from './herdr'
import { log } from './env'
import { findPane } from './state'
import { type Machine } from './machines'
import { coreFilesMachine } from './coreFilesMachine'
import type { ExecResult } from './fsx'
import { PANE_RE, splitId } from '../../shared/ids'
import { fmt } from '../../shared/message'

// Run on the machine that has `open`. Exit codes: 3 missing, 4 outside home,
// 5 not macOS, 6 `open` failed.
export const OPEN_EDITOR_SCRIPT = `p=$1
[ -d "$p" ] || exit 3
r=$(cd -P "$p" 2>/dev/null && pwd -P) || exit 3
h=$(cd -P "$HOME" 2>/dev/null && pwd -P) || exit 4
case "$r/" in "$h"/*) ;; *) exit 4 ;; esac
[ "$(uname -s)" = Darwin ] || exit 5
# The editor: WH_OPEN_EDITOR, else the first line of ~/.local/share/wherdr/editor
# (an app name for open -a), else the default app of folders.
ed=\${WH_OPEN_EDITOR:-}
if [ -z "$ed" ] && [ -f "$HOME/.local/share/wherdr/editor" ]; then
  ed=$(head -n1 "$HOME/.local/share/wherdr/editor" | tr -d '[:space:]')
fi
case "$ed" in -*) ed= ;; esac
if [ -n "$ed" ]; then
  open -a "$ed" "$r" || exit 6
else
  open "$r" || exit 6
fi
echo "$r"`

function runLocal(script: string, args: string[]): Promise<ExecResult> {
  const { promise, resolve } = Promise.withResolvers<ExecResult>()
  execFile('/bin/sh', ['-c', script, 'sh', ...args], { timeout: 15000, encoding: 'buffer' }, (err, stdout, stderr) => {
    const raw = err ? (typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined) : 0
    resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, stdout: stdout as Buffer, stderr: String(stderr || '') })
  })
  return promise
}

export function openEditorError(code: number | null, m: { label: string }, stderr = ''): HerdrError {
  switch (code) {
    case 3: return new HerdrError('not_found', fmt('The folder does not exist on {machine}', { machine: m.label }))
    case 4: return new HerdrError('outside_home', 'Only a folder in your home folder can be opened')
    case 5: return new HerdrError('not_mac', fmt('{machine} is not a Mac: Open in editor needs macOS', { machine: m.label }))
    default: return new HerdrError('open_failed', fmt('Could not open on {machine}: {reason}', { machine: m.label, reason: stderr.trim().split('\n').pop() || `code ${code}` }))
  }
}

export interface OpenEditorDeps {
  findPane: (id: string) => { cwd: string | null } | undefined
  machine: (paneMachine: string) => Promise<Machine>
  run: (m: Machine, args: string[]) => Promise<ExecResult>
}
const defaultDeps: OpenEditorDeps = {
  findPane,
  machine: coreFilesMachine,
  run: (m, args) => (m.local ? runLocal(OPEN_EDITOR_SCRIPT, args) : m.exec!(OPEN_EDITOR_SCRIPT, args, { timeoutMs: 15000 })),
}

export async function openEditor(body: { pane_id?: unknown }, deps: OpenEditorDeps = defaultDeps) {
  const paneId = String(body.pane_id || '')
  if (!PANE_RE.test(paneId)) throw new HerdrError('bad_pane', 'Invalid pane')
  const pane = deps.findPane(paneId)
  if (!pane) throw new HerdrError('bad_pane', 'Pane not found')
  const cwd = pane.cwd || ''
  if (!cwd.startsWith('/') || /[\0\n\r]/.test(cwd)) throw new HerdrError('bad_path', 'This pane has no folder')
  const m = await deps.machine(splitId(paneId).machine)
  const r = await deps.run(m, [cwd])
  log(`open-editor: ${m.label} for ${paneId}: ${r.code === 0 ? 'ok' : `refused (code ${r.code})`}`)
  if (r.code !== 0) throw openEditorError(r.code, m, r.stderr)
  return { ok: true, machine: m.label }
}
