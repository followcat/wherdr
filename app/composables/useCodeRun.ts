// Commands shown as code in an agent's replies can be copied, and run in the
// agent's own terminal, in its shell mode ("! cmd": Claude Code's bash mode,
// Codex and omp likewise; utils/shellCommand.ts). Used by the conversation
// (ChatView.vue).
import { ref } from 'vue'
import type { ChatItem, Pane, QueuedMessage } from '#shared/types'

// The pane takes commands now: online, not stale, an agent with a shell mode.
export const canRunIn = (pane: Pane | null | undefined): pane is Pane =>
  Boolean(pane) && eventsOpen.value && !offlineView.value && !paneStale(pane) && canRunCommands(pane!.agent)

// What the user confirms a command for: the same agent, session, folder and
// machine. Any change while the confirmation is open sends nothing.
export const sameTarget = (a: Pane, b: Pane | null | undefined) => Boolean(b)
  && a.id === b!.id && (a.machine || '') === (b!.machine || '') && a.agent === b!.agent
  && a.agentSession === b!.agentSession && a.cwd === b!.cwd

const livePane = (id: string) => herdrState.value.panes.find(p => p.id === id)

// Why the pane cannot take the command now, or null.
function refusal(pane: Pane | undefined): string | null {
  if (!canRunIn(pane)) return tl('The agent can no longer run commands (offline, or no agent in the pane): nothing was sent.', 'L’agent ne peut plus lancer de commande (hors ligne, ou plus d’agent dans le pane) : rien n’a été envoyé.')
  // A question on screen would take the command as its typed answer.
  if (pane.status === 'blocked' && pane.prompt) return tl('The agent is waiting for your answer: answer it first.', 'L’agent attend ta réponse : réponds-lui d’abord.')
  return null
}

// The confirmation names where the command goes: agent, pane, machine, folder.
export function runQuestion(pane: Pane): string {
  const name = kindLabel(pane.agent)
  // The space ("acme"), then the pane's own title when it says more.
  const space = workspaceLabel(herdrState.value, pane)
  const own = paneTitle(pane)
  const title = [space, own].filter((x, i, all) => x && x.toLowerCase() !== name.toLowerCase() && all.indexOf(x) === i).join(' › ') || own
  const machine = pane.machine ? machineName(pane.machine) : ''
  const folder = pane.cwd ? shortPath(pane.cwd) : ''
  return tl(
    `Run this command in ${name} “${title}”${machine ? ` on ${machine}` : ''}? It runs in its shell mode (!), in ${folder || 'its own folder'}, and shows the output in the conversation.`,
    `Lancer cette commande dans ${name} « ${title} »${machine ? ` sur ${machine}` : ''} ? Elle s’exécute dans son mode shell (!), dans ${folder || 'son propre dossier'}, et la sortie s’affiche dans la conversation.`,
  )
}

// Runs `cmd` in the agent of pane `paneId`, only after the user has seen it in
// full, with its target, and confirmed. Never on its own. The pane is read
// again once confirmed: if it changed (another agent or session, another
// folder, offline, a question on screen), nothing is sent. null or a queued
// message: sent. false: not sent (the user has been told when it matters).
export async function runInAgent(paneId: string, cmd: string): Promise<QueuedMessage | null | false> {
  const pane = livePane(paneId)
  const before = refusal(pane)
  if (before || !pane) {
    if (before) toast(before, true)
    return false
  }
  const text = runMessage(pane.agent, cmd)
  if (!text) return false
  haptic()
  const ok = await askConfirm(runQuestion(pane), tl('Run', 'Lancer'), 'primary', cmd)
  if (!ok) return false
  const now = livePane(paneId)
  if (!sameTarget(pane, now)) {
    toast(tl('The agent changed while you were confirming: nothing was sent. Check it and run the command again.', 'L’agent a changé pendant la confirmation : rien n’a été envoyé. Vérifie-le et relance la commande.'), true)
    return false
  }
  const after = refusal(now)
  if (after) {
    toast(after, true)
    return false
  }
  try {
    const queued = await sendMessage(now, now!.id, text)
    haptic()
    return queued
  } catch (err) {
    toast((err as Error).message, true)
    return false
  }
}

export async function copyCode(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(t('Copied'))
  } catch { toast(t('Copy failed'), true) }
}

// ------------------------------------------------------------ runs
// Commands run with Run, per pane, from the moment they are sent: the
// conversation shows each at once as a live card (ChatView), and the button
// says "Running…", then "Ran at 16:42". The transcript only writes a "!"
// command once it has finished; that entry then replaces the live card.
// A run's entry is the first one of the same command, with its output,
// written from the run's start on and not taken by another run: never by its
// place in the loaded list, which grows at the top (older messages) or
// restarts. `entry`: the entry taken (its time and command). `doneAt`: when it finished.
export interface CodeRun { cmd: string, at: number, entry?: string, doneAt?: number }
type RunEntry = Pick<ChatItem, 'role' | 'text' | 'ts' | 'ms' | 'out' | 'omp'>
// Past this, a run the transcript never wrote (lost, cleared) stops showing as running.
export const RUN_MAX_MS = 3_600_000
// The entry's time is the agent's start of the command, a little before the
// click is recorded (after the send), on another machine's clock.
export const RUN_SKEW_MS = 30_000
const RUNS_KEPT = 20
export const codeRuns = ref<Record<string, CodeRun[]>>({})

// The same command, whatever its spacing (the screen wraps a long one, even mid-word).
const flat = (s: string) => String(s || '').replace(/\s+/g, '')
export const sameCmd = (a: string, b: string) => flat(a) === flat(b)
const entryKey = (it: RunEntry) => `${it.ts}\0${flat(it.text)}`

// The runs with those whose entry has landed (or that ran too long) marked done.
export function settleRuns(runs: readonly CodeRun[], items: readonly RunEntry[], now: number): CodeRun[] {
  const taken = new Set(runs.map(r => r.entry).filter(Boolean))
  // Finished once its output is written (omp: its tool view), oldest first.
  const landed = items.filter(it => it.role === 'bash' && it.ts && (it.out !== undefined || it.omp))
    .map(it => ({ it, t: Date.parse(it.ts!) })).filter(x => x.t >= 0).sort((a, b) => a.t - b.t)
  return runs.map((r) => {
    if (r.doneAt !== undefined) return r
    const hit = landed.find(x => x.t >= r.at - RUN_SKEW_MS && sameCmd(x.it.text, r.cmd) && !taken.has(entryKey(x.it)))
    if (hit) {
      taken.add(entryKey(hit.it))
      const end = hit.t + (hit.it.ms || 0)
      return { ...r, entry: entryKey(hit.it), doneAt: end >= r.at ? end : now }
    }
    return now - r.at > RUN_MAX_MS ? { ...r, doneAt: now } : r
  })
}

export function addRun(paneId: string, cmd: string) {
  const list = codeRuns.value[paneId] || []
  codeRuns.value = { ...codeRuns.value, [paneId]: [...list, { cmd, at: Date.now() }].slice(-RUNS_KEPT) }
}

// The Run button's state per command (key: runKey): running, or the time of its last run.
export const runKey = flat
export type RunMark = { running: boolean, at: number }
export function runMarks(runs: readonly CodeRun[]): Record<string, RunMark> {
  const out: Record<string, RunMark> = {}
  for (const r of runs) {
    const k = flat(r.cmd)
    const running = r.doneAt === undefined
    out[k] = { running: running || Boolean(out[k]?.running), at: running ? r.at : r.doneAt! }
  }
  return out
}
