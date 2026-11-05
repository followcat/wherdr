// Incremental re-reads of a conversation's bottom (/api/chat).
//
// Each re-read of the bottom used to send every message from `from` to the
// end of the file again: about 400 KB for 2,000 messages, for one new line.
// For clients that splice (they send `n`, the number of items they hold), the
// reply token ends with a fingerprint of the exact list sent (`#<hash>`), and
// the server remembers, per pane, a signature of each item of the last lists
// it sent them. When such a client comes back with that token and its count,
// the server sends only what follows the common prefix: `keep` (items to
// keep) and the items after them. Changed items (a tool that got its result,
// the reply being written) are inside that suffix, since the suffix starts at
// the first difference.
//
// Anything unknown (server restarted, list forgotten or expired, other count,
// other start) gets the full list, exactly as before, and such a token never
// earns an "unchanged" reply (see knows): the delta is an optimisation, never
// a source of truth. Readers without `n` (older app, plugins) keep the plain
// transcript token, its "unchanged" replies, and cost no signatures.
//
// Memory: 8 bytes per item and list, a few lists per pane, a global budget,
// lists unused for a while expire, and a closed pane is forgotten
// (state.ts).
import { createHash } from 'node:crypto'
import type { ChatItem } from '../../shared/types'

const FP = /#([0-9a-f]{16})$/
const LISTS_PER_PANE = 4 // several devices on the same pane, a little history
const MAX_SIGS = 400_000 // all panes together: 3.2 MB of signatures
const TTL_MS = 15 * 60 * 1000 // since the list was last sent or polled

// 64-bit signature per item: two 32-bit words of the item's SHA-1. Computed
// once per item object: the transcript readers hand out the same object
// again for an item that did not change since (claudeParser, the turns kept
// for Codex and omp), so a poll signs only the new and changed items. The
// contract: an item given here is never changed afterwards.
const signed = new WeakMap<ChatItem, [number, number]>()
export function itemSigs(items: ChatItem[]): Uint32Array {
  const out = new Uint32Array(items.length * 2)
  items.forEach((it, k) => {
    let sig = signed.get(it)
    if (!sig) {
      const h = createHash('sha1').update(JSON.stringify(it)).digest()
      signed.set(it, sig = [h.readUInt32LE(0), h.readUInt32LE(4)])
    }
    out[2 * k] = sig[0]
    out[2 * k + 1] = sig[1]
  })
  return out
}
const listFp = (sigs: Uint32Array) => createHash('sha1').update(new Uint8Array(sigs.buffer, sigs.byteOffset, sigs.byteLength)).digest('hex').slice(0, 16)

// Splits a client token into the transcript's own token and the fingerprint.
export function splitToken(token: string): { base: string, fp: string | null } {
  const m = FP.exec(token)
  return m ? { base: token.slice(0, m.index), fp: m[1]! } : { base: token, fp: null }
}

interface List { sigs: Uint32Array, at: number }

export function createChatDelta({ now = Date.now, maxSigs = MAX_SIGS, ttl = TTL_MS }: { now?: () => number, maxSigs?: number, ttl?: number } = {}) {
  // pane -> token (with fingerprint) -> item signatures, oldest first.
  const panes = new Map<string, Map<string, List>>()
  let total = 0 // items remembered, all lists together

  function drop(pane: string, token: string) {
    const lists = panes.get(pane)
    const l = lists?.get(token)
    if (!lists || !l) return
    total -= l.sigs.length / 2
    lists.delete(token)
    if (!lists.size) panes.delete(pane)
  }
  function forget(pane: string) {
    for (const token of [...panes.get(pane)?.keys() || []]) drop(pane, token)
  }
  // Expired lists, then the least recently used ones beyond the budget.
  function prune() {
    const t = now()
    const all: { pane: string, token: string, at: number }[] = []
    for (const [pane, lists] of panes) {
      for (const [token, l] of lists) {
        if (t - l.at > ttl) drop(pane, token)
        else all.push({ pane, token, at: l.at })
      }
    }
    if (total <= maxSigs) return
    all.sort((a, b) => a.at - b.at)
    for (const e of all) {
      if (total <= maxSigs) break
      drop(e.pane, e.token)
    }
  }
  function remember(pane: string, token: string, sigs: Uint32Array) {
    drop(pane, token)
    if (sigs.length / 2 > maxSigs) return // too long to remember: full lists
    let lists = panes.get(pane)
    if (!lists) panes.set(pane, lists = new Map())
    lists.set(token, { sigs, at: now() })
    total += sigs.length / 2
    while (lists.size > LISTS_PER_PANE) drop(pane, lists.keys().next().value!)
    prune()
  }
  // A list the client says it holds, if remembered with that count (touched).
  function held(pane: string, since: string, n: number | null): Uint32Array | null {
    const l = n === null ? undefined : panes.get(pane)?.get(since)
    if (!l) return null
    if (now() - l.at > ttl) { drop(pane, since); return null }
    if (l.sigs.length / 2 !== n) return null
    l.at = now()
    return l.sigs
  }

  // `token`: the transcript's token for `items` (without fingerprint).
  // `since` / `n`: what the client says it holds (token as received, item
  // count; null: a reader that does not splice). `sameStart`: the items start
  // where the client's list starts.
  function reply(pane: string, token: string, items: ChatItem[], since: string, n: number | null, sameStart: boolean) {
    if (n === null) return { token, items }
    const sigs = itemSigs(items)
    const full = `${token}#${listFp(sigs)}`
    const old = sameStart && splitToken(since).fp ? held(pane, since, n) : null
    remember(pane, full, sigs)
    if (!old) return { token: full, items }
    let keep = 0
    const max = Math.min(old.length, sigs.length) / 2
    while (keep < max && old[2 * keep] === sigs[2 * keep] && old[2 * keep + 1] === sigs[2 * keep + 1]) keep++
    return { token: full, items: items.slice(keep), keep }
  }

  // Whether the client's list is one the server sent and remembers, with
  // that many items. Otherwise its token must not earn an "unchanged" reply.
  const knows = (pane: string, since: string, n: number | null) => held(pane, since, n) !== null

  // Transcript token to compare with the file (`since` of transcripts.chat):
  // '' for a fingerprinted token it does not know with that count.
  const sinceOf = (pane: string, sent: string, n: number | null) => {
    const t = splitToken(sent)
    return !t.fp || knows(pane, sent, n) ? t.base : ''
  }

  return { reply, knows, sinceOf, forget, ids: () => [...panes.keys()], size: () => total }
}

export const chatDelta = createChatDelta()
