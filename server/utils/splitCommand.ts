import { PANE_RE, joinId, splitId } from '../../shared/ids'
import { herdrOn, HerdrError, sleep } from './herdr'
import { reduceSnapshot } from './snapshot'
import { prepareSplitShell, SPLIT_PROMPT_TOKEN, SPLIT_TERMINAL_TOKEN } from './splitShell'

type Call = typeof herdrOn
const pending = new Map<string, Promise<unknown>>()
// How long a new shell gets to show its prompt (slow startup files, remote machines).
const START_WAIT_MS = 5000
const START_STEP_MS = 100

// Serialize our own sends on each machine, including across different agents
// sharing a tab. Never infer readiness from the cached UI state.
export async function runSplitCommand(paneId: string, raw: unknown, call: Call = herdrOn, prepare = prepareSplitShell) {
  if (!PANE_RE.test(paneId)) throw new HerdrError('bad_pane', 'Pane not found')
  const command = typeof raw === 'string' ? raw.trim().replace(/^!\s*/, '') : ''
  if (!command || /[\r\n\x00-\x1f\x7f]/.test(command)) throw new HerdrError('bad_command', 'Expected a single shell command')
  const { machine, local } = splitId(paneId)
  const previous = pending.get(machine)
  const task = (async () => {
    await previous?.catch(() => {})
    const hx = (method: string, params: Record<string, unknown> = {}) => call(machine, method, params)
    const snap = await hx('session.snapshot')
    const state = reduceSnapshot(snap.snapshot || snap)
    const agent = state.panes.find(p => p.id === local)
    if (!agent?.agent || !agent.cwd) throw new HerdrError('bad_pane', 'Pane not found')
    // A shell is free when it is alone in the foreground: no child process.
    // Splits this action opened also attest to their prompt through shell
    // hooks, which also rules out a waiting builtin (`read`). A shell the user
    // opened has no hooks, so the foreground check is all there is.
    const inspect = async (id: string) => {
      const p = (await hx('pane.get', { pane_id: id })).pane
      if (!p || p.agent || p.tab_id !== agent.tab) return { free: false, managed: false, alone: false }
      const info = (await hx('pane.process_info', { pane_id: id })).process_info
      const alone = Boolean(info?.shell_pid > 0 && info.foreground_process_group_id === info.shell_pid
        && info.foreground_processes?.length && info.foreground_processes.every((p: { pid: number }) => p.pid === info.shell_pid))
      const managed = p.tokens?.[SPLIT_TERMINAL_TOKEN] === '1'
      return { free: alone && (!managed || p.tokens?.[SPLIT_PROMPT_TOKEN] === String(info.shell_pid)), managed, alone }
    }
    const ready = async (id: string) => (await inspect(id)).free
    const siblings = state.panes.filter(p => p.id !== local && p.tab === agent.tab && !p.agent)
    let target: string | undefined
    let fallback: string | undefined
    for (const p of siblings) {
      const s = await inspect(p.id)
      if (!s.free) continue
      if (s.managed) { target = p.id; break }
      fallback ??= p.id
    }
    target ??= fallback
    // A shell that loses readiness while we focus it is left untouched; create another split.
    if (target) {
      await hx('pane.focus', { pane_id: target })
      if (!await ready(target)) target = undefined
    }
    const created = !target
    if (!target) {
      // The first terminal opens right of the agent. Later ones stack under the
      // last sibling, so the agent keeps its width.
      const last = siblings.at(-1)
      const r = await hx('pane.split', { target_pane_id: last?.id ?? local, direction: last ? 'down' : 'right', cwd: agent.cwd, focus: false, env: await prepare(machine) })
      target = r.pane?.pane_id
      if (!target) throw new HerdrError('bad_pane', 'Pane not found')
      await hx('pane.report_metadata', { pane_id: target, source: 'wherdr-split', tokens: { [SPLIT_TERMINAL_TOKEN]: '1' } })
      // Never buffer text into an unverified pane, even one this request opened.
      const deadline = Date.now() + START_WAIT_MS
      let s = await inspect(target)
      while (!s.free && Date.now() < deadline) {
        await sleep(START_STEP_MS)
        s = await inspect(target)
      }
      // No prompt report (fish, sh, an old bash, a PROMPT_COMMAND reset by
      // .bashrc): treat it as a plain shell from now on, so it is reused later.
      if (!s.free && s.alone) {
        await hx('pane.report_metadata', { pane_id: target, source: 'wherdr-split', tokens: { [SPLIT_TERMINAL_TOKEN]: null } })
        s = await inspect(target)
      }
      await hx('pane.focus', { pane_id: target })
      if (!s.free || !await ready(target)) throw new HerdrError('busy_pane', 'Cannot verify an idle shell prompt. No command was sent.')
    }
    await hx('pane.report_metadata', { pane_id: target, source: 'wherdr-split', tokens: { [SPLIT_PROMPT_TOKEN]: null } })
    // Clear what the user typed without pressing Enter, so it does not merge
    // with the command. Bash and zsh keep it in the kill ring (Ctrl+Y).
    await hx('pane.send_input', { pane_id: target, keys: ['ctrl+e', 'ctrl+u'] })
    await hx('pane.send_input', { pane_id: target, text: command, keys: ['enter'] })
    return { ok: true, pane_id: joinId(machine, target), created }
  })()
  pending.set(machine, task)
  try { return await task }
  finally { if (pending.get(machine) === task) pending.delete(machine) }
}
