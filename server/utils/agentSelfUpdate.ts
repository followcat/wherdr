// Observe an actual Codex -> shell transition, once per process. Never scan
// arbitrary shell panes for an old log: `cat` of a quoted update is not an update.
import { readPassiveScreen } from './passiveScreen'
import type { Pane, ChatResponse } from '../../shared/types'
import { updatePrompt, updateShellSignature, type UpdateLaunch } from '../../shared/selfUpdate'
import { paneForeground, type RestartDeps } from './restartSeq'

interface LastAgent extends UpdateLaunch {
  pid: number
  pane: Pane
  at: number
  gone?: number
  checked?: boolean
  signature?: string
  oldOutput?: boolean
}
export interface SelfUpdateDeps extends RestartDeps {
  chat: (p: Pane) => Promise<ChatResponse>
  // `sync`: last write before the service stops.
  save?: (records: [string, LastAgent][], sync?: boolean) => void
}
// How often the last time Codex was seen alive (`at`) is written on its own.
export const AT_SAVE_MS = 60 * 1000
// Longest outage after which an exit still counts as observed.
const OUTAGE_MS = 15000
export function createSelfUpdates(d: SelfUpdateDeps, saved: [string, LastAgent][] = []) {
  const records = new Map(saved)
  // Read back from the disk and not seen alive since: without flush() (the
  // service was killed), their `at` may be up to AT_SAVE_MS old.
  const restored = new Set(records.keys())
  // `at` moves on every pass while Codex lives: alone it is not worth a disk
  // write every second. It is saved with the next real change, by flush(),
  // and otherwise once a minute, so that a service killed without flush()
  // still knows when Codex was last alive.
  const stable = () => JSON.stringify([...records].map(([id, r]) => [id, { ...r, at: 0 }]))
  const times = () => [...records.values()].map(r => r.at).join()
  let written = stable()
  let writtenTimes = times()
  let writtenAt = d.now()
  const persist = () => {
    const s = stable()
    if (s === written && (d.now() - writtenAt < AT_SAVE_MS || times() === writtenTimes)) return
    written = s
    writtenTimes = times()
    writtenAt = d.now()
    d.save?.([...records])
  }
  // Called only after atShell: the shell uses the normal screen, where Herdr
  // never scrolls the application. Keep unwrapped history for narrow or scrolled views.
  const readShell = async (id: string) => String((await d.call('pane.read', { pane_id: id, source: 'recent_unwrapped', lines: 80 }, 4000))?.read?.text || '')
  return {
    get: (id: string) => records.get(id),
    clear(id: string) { records.delete(id); persist() },
    // Service stopping: keep the exact time Codex was last seen alive, so a
    // quick restart still tells a short outage from a long one.
    flush() { if (records.size) d.save?.([...records], true) },
    prune(ids: Set<string>, belongs: (id: string) => boolean) {
      let changed = false
      for (const id of records.keys()) if (belongs(id) && !ids.has(id)) { records.delete(id); changed = true }
      if (changed) persist()
    },
    async observe(p: Pane, owned: boolean): Promise<boolean> {
      if (owned) return false
      let last = records.get(p.id)
      if (p.agent === 'codex') {
        // Process identity is checked on every observation. The transcript
        // throttle must never reuse another invocation's launch arguments.
        const fg = await paneForeground(d, p.id, 'codex')
        if (!fg.agent) return false // installer may still be exiting
        restored.delete(p.id)
        const pid = Number(fg.agent.pid)
        if (last && last.pid === pid && !last.gone && d.now() - last.at < 5000
          && p.agentSession === last.pane.agentSession && p.cwd === last.pane.cwd
          && p.bornAt === last.pane.bornAt) {
          last.argv = fg.argv || last.argv
          persist()
          return false
        }
        if (!last || last.pid !== pid || last.gone) {
          last = { pid, pane: { ...p }, at: d.now(), argv: fg.argv, session: null, conversation: 'unknown' }
          records.set(p.id, last)
        }
        last.at = d.now()
        last.argv = fg.argv || last.argv
        last.pane = { id: p.id, workspace: p.workspace, agent: p.agent, agentSession: p.agentSession, bornAt: p.bornAt, cwd: p.cwd, name: p.name, title: p.title } as Pane
        const screen = await readPassiveScreen(d.call, p.id)
        const chat = await d.chat(p).catch(() => null)
        // Even a guessed session can contradict an earlier exact identity.
        // It cannot establish a replacement, but must invalidate the old one.
        if (chat && (chat.guessed || (chat.session && chat.session !== last.session))) {
          if (chat.session !== last.session) last.conversation = 'unknown'
          last.session = null
        }
        if (chat?.available && !chat.guessed && chat.session) {
          if (last.session && last.session !== chat.session) last.conversation = 'unknown'
          last.session = chat.session
        }
        if (chat?.items?.some(i => i.role === 'user' || i.role === 'assistant')) {
          last.conversation = 'existing'
          // Transcript resolution corrects Herdr's shared-daemon session reports.
          if (!chat.guessed && chat.session) last.session = chat.session
        } else if (chat && last.conversation !== 'existing') {
          const startup = /(?:✨\s*)?Update available!|^Updating Codex via /m.test(screen)
          const witnessedBirth = Boolean(p.bornAt) && !fg.argv?.some(a => a === 'resume' || a === 'fork')
          if ((chat.available && !chat.guessed && !chat.start && !chat.items?.length)
            || (!p.agentSession && !chat.available && (startup || witnessedBirth))) last.conversation = 'empty'
        }
        last.oldOutput = Boolean(updateShellSignature(screen))
        persist()
        return false
      }
      if (!last) return false
      if (p.agent) { records.delete(p.id); persist(); return false }
      if (!last.gone) {
        // A long service outage is not an observed exit. An old saved record
        // must not arm detection for arbitrary shell output on reconnection.
        if (d.now() - last.at > OUTAGE_MS + (restored.has(p.id) ? AT_SAVE_MS : 0)) last.checked = true
        last.gone = d.now()
        persist()
      }
      if (!last.checked) {
        // Give the installer and a multiline shell prompt time to finish.
        // Until then the pane is a bare shell: flagged so that a message is
        // held instead of being typed there and run as a command.
        if (d.now() - last.gone < 3000) { p.leaving = true; return false }
        last.checked = true
        if (d.now() - last.gone < 15000 && !last.oldOutput && (await paneForeground(d, p.id, 'codex')).atShell) {
          last.signature = updateShellSignature(await readShell(p.id)) || undefined
          if (last.signature) {
            // The final messages may have arrived since the last live sample.
            // Re-read the retained session before deciding there is nothing to resume.
            const chat = await d.chat(last.pane).catch(() => null)
            if (!chat || chat.guessed || (!chat.available && last.session)) {
              // Absence of messages was only a live snapshot. Failure to
              // confirm it at exit must offer Resume / Start fresh.
              if (last.conversation === 'empty') last.conversation = 'unknown'
            }
            if (chat && (chat.guessed || (chat.session && chat.session !== last.session))) last.session = null
            if (chat?.available && !chat.guessed && chat.session) last.session = chat.session
            if (chat?.items?.some(i => i.role === 'user' || i.role === 'assistant')) {
              last.conversation = 'existing'
              if (!chat.guessed && chat.session) last.session = chat.session
              else if (chat.session !== last.session) last.session = null
            }
          }
        }
        persist()
      }
      if (!last.signature) return false
      p.agent = 'codex'
      p.name = last.pane.name
      p.title = last.pane.title
      p.agentSession = last.session
      p.bornAt = last.pane.bornAt
      p.status = 'blocked'
      p.stopped = { reason: 'update' }
      p.prompt = updatePrompt(last)
      return true
    },
    async check(id: string) {
      const last = records.get(id)
      if (!last?.signature || !(await paneForeground(d, id, 'codex')).atShell) return null
      return updateShellSignature(await readShell(id)) === last.signature ? last : null
    },
  }
}
