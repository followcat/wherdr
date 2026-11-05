// Composer, keys, interrupt and stop on herdr-core: terminal.send / keys /
// interrupt / kill on the pane's full core address. Never retried: a timeout
// does not prove the text or key did not reach the program.
import { coreCall, CoreError } from './core'
import { HerdrError } from './herdr'
import { keepPastes } from './pastes'
import { isBareBang, isSlashCommand } from '../../shared/queuedMatch'
import type { Pane } from '../../shared/types'

type Call = <T>(method: string, params: object, timeout: number) => Promise<T>
export interface CoreInputDeps {
  call: Call
  pane: (id: string) => Pane | undefined
  panes: () => Pane[]
  refresh: () => void
  /** After a Stop from the conversation: the prompt Claude put back into its field, taken out of it. */
  takeBack?: (p: Pane) => Promise<{ text: string, lost: number } | null>
  settleMs?: number
}

const KEY_RE = /^[a-z0-9+\-]{1,24}$/i
const MAX_TEXT = 256 * 1024

export function coreInputDeps(): CoreInputDeps {
  return {
    call: (method, params, timeout) => {
      const endpoint = process.env.HC_SOCKET
      if (!endpoint) return Promise.reject(new CoreError('unavailable', 'Missing core endpoint'))
      return coreCall(endpoint, method, params, timeout)
    },
    pane: id => findPane(id),
    panes: () => getState().panes,
    refresh: () => { setTimeout(() => { void poll() }, 100) },
    takeBack: (p) => {
      const call = (method: string, params: object, t: number) => coreCall(process.env.HC_SOCKET || '', method, params, t)
      return takeBackFromClaude(p, {
        // Core's plain screen: Claude's field starts with "❯" + a space (a non-breaking one in ANSI).
        screen: async () => String(((await call('terminal.read', { terminal: p.coreAddress, lines: 0 }, 4000)) as { text?: string }).text || '').replace(/^❯ /gm, '❯\u00a0'),
        keys: async (keys) => { await call('terminal.keys', { terminal: p.coreAddress, keys }, 10000) },
      }).then(item => (item ? takeBack(p.id, item) : null))
    },
  }
}

function target(deps: CoreInputDeps, id: unknown) {
  const p = typeof id === 'string' ? deps.pane(id) : undefined
  if (!p?.coreAddress) throw new HerdrError('bad_pane', 'Pane not found')
  return p
}

// Core's stable error kinds, as the interface's messages.
export function failure(e: unknown): never {
  if (e instanceof HerdrError) throw e
  const kind = e instanceof CoreError ? e.kind : 'internal'
  if (kind === 'not_found' || kind === 'finished') throw new HerdrError('stale', 'This terminal has ended')
  if (kind === 'blocked') throw new HerdrError('blocked', 'The agent is waiting for an answer: reply in the terminal')
  if (kind === 'name_taken') throw new HerdrError('name_taken', 'A terminal with this name already exists')
  if (kind === 'spawn_failed') throw new HerdrError('spawn_failed', 'The program could not start: check the folder and that it is installed')
  if (kind === 'timeout') throw new HerdrError('timeout', 'herdr-core did not confirm in time: check the terminal before sending again')
  if (kind === 'unreachable' || kind === 'machine_unknown') throw new HerdrError('unreachable', 'The machine of this terminal is unreachable')
  if (kind === 'unavailable' || kind === 'disconnected') throw new HerdrError('unreachable', 'herdr-core is unreachable')
  throw new HerdrError(kind, e instanceof Error ? e.message : 'herdr-core rejected the request')
}

// Message from the composer: pasted, then submitted with Enter once nobody types.
export async function coreSend(deps: CoreInputDeps, b: { pane_id?: unknown, text?: unknown, pastes?: unknown }) {
  const p = target(deps, b.pane_id)
  const text = typeof b.text === 'string' ? b.text : ''
  if (!text.trim() || isBareBang(text)) throw new HerdrError('empty', 'Empty message')
  if (text.length > MAX_TEXT) throw new HerdrError('too_large', 'Message too large')
  if (!isSlashCommand(text)) keepPastes(text, b.pastes)
  try {
    const r = await deps.call<{ started?: boolean | null }>('terminal.send', { terminal: p.coreAddress, text }, 30000)
    let started = r?.started ?? null
    // Claude takes a multi-line send (text + "\n@file") as a paste and leaves it in its
    // input: core reports no turn started. One more Enter submits it; on an empty input it is harmless.
    if (started === false && text.includes('\n')) {
      await new Promise(res => setTimeout(res, deps.settleMs ?? 400))
      const t = await deps.call<{ status?: string | { state?: string } | null }>('terminal.get', { terminal: p.coreAddress }, 3000).catch(() => null)
      const state = typeof t?.status === 'string' ? t.status : t?.status?.state
      if (state === 'idle' || state === 'done') {
        await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['enter'] }, 10000)
        started = null // unconfirmed: Enter pressed, no turn observed yet
      }
    }
    return { ok: true, started }
  } catch (e) { failure(e) } finally { deps.refresh() }
}

// Raw route: text + Enter is a message, named keys go through terminal.keys.
export async function coreInput(deps: CoreInputDeps, b: { pane_id?: unknown, text?: unknown, keys?: unknown }) {
  const keys = Array.isArray(b.keys) ? b.keys : []
  if (typeof b.text === 'string' && b.text) {
    if (keys.length !== 1 || keys[0] !== 'enter') throw new HerdrError('unsupported', 'Type this text in the terminal')
    return coreSend(deps, b)
  }
  const p = target(deps, b.pane_id)
  if (!keys.length || keys.length > 32 || !keys.every(k => typeof k === 'string' && KEY_RE.test(k))) throw new HerdrError('bad_keys', 'Invalid keys')
  try {
    await deps.call('terminal.keys', { terminal: p.coreAddress, keys }, 10000)
    return { ok: true }
  } catch (e) { failure(e) } finally { deps.refresh() }
}

// Stop button: the stop key, then what core observed. Never escalates to a kill.
export async function coreInterrupt(deps: CoreInputDeps, b: { pane_id?: unknown, restore?: unknown }) {
  const p = target(deps, b.pane_id)
  try {
    const r = await deps.call<{ outcome: string }>('terminal.interrupt', { terminal: p.coreAddress, timeout: 10 }, 15000)
    const stopped = r.outcome === 'stopped' || r.outcome === 'exited'
    // Claude puts the message it had not sent back into its field: it leaves the
    // conversation and returns to wherdr's field (see interruptRestore.ts).
    const back = stopped && b.restore === true && p.agent === 'claude' && deps.takeBack ? await deps.takeBack(p).catch(() => null) : null
    return { ok: true, outcome: r.outcome, stopped, background: 0, shell: !p.agent, ...(back ? { restored: back.text, ...(back.lost ? { lost: back.lost } : {}) } : {}) }
  } catch (e) { failure(e) } finally { deps.refresh() }
}

// Close: ends the program (hangup, terminate, kill). A group ends each of its terminals.
export async function coreKill(deps: CoreInputDeps, b: { pane_id?: unknown, close_group?: unknown }) {
  const p = target(deps, b.pane_id)
  const list = b.close_group === true ? deps.panes().filter(x => x.workspace === p.workspace && x.coreAddress) : [p]
  try {
    for (const x of list) await deps.call('terminal.kill', { terminal: x.coreAddress }, 15000)
    return { ok: true }
  } catch (e) { failure(e) } finally { deps.refresh() }
}

// "Keep after restart": a kept terminal comes back as a shell when core restarts or loses it.
// terminal.list does not carry the flag, so it is read on demand with terminal.get.
export async function coreKeepGet(deps: CoreInputDeps, id: unknown) {
  const p = target(deps, id)
  try {
    const t = await deps.call<{ keep?: boolean }>('terminal.get', { terminal: p.coreAddress }, 5000)
    return { keep: t.keep === true }
  } catch (e) { failure(e) }
}

export async function coreKeepSet(deps: CoreInputDeps, b: { pane_id?: unknown, keep?: unknown }) {
  if (typeof b.keep !== 'boolean') throw new HerdrError('bad_keep', 'Invalid value')
  const p = target(deps, b.pane_id)
  try {
    await deps.call('terminal.keep', { terminal: p.coreAddress, keep: b.keep }, 5000)
    return { keep: b.keep }
  } catch (e) { failure(e) }
}
