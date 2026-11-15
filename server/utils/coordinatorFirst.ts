// A coordinator's first messages (its start prompt, the first-start workflow proposal,
// card notes): typed one after another once its session is ready, however long it takes
// to start (bounded by queueWatchMs), never dropped silently. Each outcome goes to the
// project's log; one not delivered stays on its record (undelivered) so that the
// coordinator row and Alfred say so, with Send again (resendFirst).
// Coordinators start one after another: each start waits until the one before is up
// (its first message typed or failed), at most startGapMs, so that several Claude
// sessions starting at once (the v2 import card) do not slow each other past the bound.
import { HerdrError } from './herdr'
import { sendFirstMessage, type CoreAdminDeps } from './coreCreate'
import type { PmStore } from './pmStore'

export type FirstDeps = CoreAdminDeps & { store: Pick<PmStore, 'coordinator' | 'saveCoordinator' | 'logProject'>, startGapMs?: number }
export interface Undelivered { texts: string[], why: string, at: number }

const BY = 'wherdr'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const log = (deps: FirstDeps, key: string, text: string) => deps.store.logProject(key, { by: BY, text }).catch(() => {})

// The record of this conversation only: a later start replaced it otherwise.
async function mark(deps: FirstDeps, key: string, address: string, undelivered?: Undelivered) {
  const rec = await deps.store.coordinator(key)
  if (!rec || rec.terminal !== address || (!undelivered && !rec.undelivered)) return
  const { undelivered: _old, ...rest } = rec
  await deps.store.saveCoordinator({ ...rest, ...(undelivered ? { undelivered } : {}) })
}

const WHY = { dialog: 'a dialog waits for an answer', installing: 'it is installing an update', skipped: 'not ready yet', unreachable: 'its machine does not answer' }
const statusOf = (t: { status?: string | { state?: string } | null }) => (typeof t.status === 'string' ? t.status : t.status?.state)

// up: called once with the first outcome (the session is up, or gone).
// inArgv: the messages went on its command line (a fresh Claude or Codex): only watched
// until its session is up (idle or working), so that a start that never comes up says so.
// A terminal.get that fails (a timeout, the machine briefly unreachable) is retried.
export async function deliverFirst(deps: FirstDeps, key: string, address: string, texts: string[], up: () => void = () => {}, inArgv = false): Promise<'sent' | 'failed'> {
  const limit = deps.queueWatchMs ?? 600_000, end = Date.now() + limit
  let i = 0, why = '', queued = false
  while (inArgv || i < texts.length) {
    let r: keyof typeof WHY | 'sent' = 'unreachable'
    const t = await deps.call<{ state?: string, status?: string | { state?: string } | null }>('terminal.get', { terminal: address }, 3000).catch(() => undefined)
    if (t !== undefined) {
      if (!t?.state || t.state === 'finished') { why = 'its session ended before it was ready'; break }
      if (inArgv) {
        const s = statusOf(t)
        if (s === 'idle' || s === 'working') break
        r = s === 'blocked' ? 'dialog' : 'skipped'
      } else {
        r = await sendFirstMessage(deps, address, texts[i]!).catch(() => 'skipped' as const)
        if (r === 'sent') { i++; up(); continue }
      }
    }
    if (Date.now() >= end) { why = `it was not ready after ${Math.round(limit / 60_000)} min`; break }
    if (!queued && texts.length) {
      queued = true
      await log(deps, key, `first message queued (${WHY[r as keyof typeof WHY]}): ${inArgv ? 'given at its start, watched until its session is up' : 'typed once it is ready'}`)
    }
    await sleep((deps.pollMs ?? 500) * 2)
  }
  up()
  if (!why) {
    if (texts.length) await log(deps, key, `first message ${inArgv ? 'given at its start, its session is up' : 'sent'}${texts.length > 1 ? ` (${texts.length} messages)` : ''}`)
    await mark(deps, key, address)
    return 'sent'
  }
  if (!texts.length) return 'failed'
  await log(deps, key, `first message not delivered: ${why}`)
  await mark(deps, key, address, { texts: inArgv ? texts : texts.slice(i), why, at: Date.now() })
  return 'failed'
}

// One start at a time: resolves once the start before is up (or after startGapMs);
// the caller calls the returned function once its own session is up.
let previous: Promise<void> = Promise.resolve()
export async function startTurn(deps: Pick<FirstDeps, 'startGapMs'>): Promise<() => void> {
  const before = previous
  let done!: () => void
  previous = new Promise<void>(r => (done = r))
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([before, new Promise<void>(r => (timer = setTimeout(r, deps.startGapMs ?? 20_000)))])
  clearTimeout(timer)
  return done
}

// Send again: the messages not delivered, queued again to its running conversation; its
// session ended (or never came up): `restart` starts a new one, which takes them
// (startCoordinator replays a record's undelivered messages at any start).
export async function resendFirst(deps: FirstDeps, key: string, restart: () => Promise<unknown>) {
  const rec = await deps.store.coordinator(key)
  if (!rec?.undelivered) throw new HerdrError('not_found', 'No first message waits to be sent again')
  const t = !rec.terminal ? null : await deps.call<{ state?: string }>('terminal.get', { terminal: rec.terminal }, 3000).catch(() => null)
  if (!rec.terminal || !t?.state || t.state === 'finished') return restart().then(() => ({ restarted: true, queued: rec.undelivered!.texts.length }))
  const { undelivered, ...rest } = rec
  await deps.store.saveCoordinator(rest)
  void deliverFirst(deps, key, rec.terminal!, undelivered.texts)
  return { queued: undelivered.texts.length }
}
