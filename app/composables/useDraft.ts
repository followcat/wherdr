// Input field drafts, one per conversation: the text and attached photos
// stay when switching conversations, and even after an
// app reload (localStorage). The photos are already stored on the
// server: we keep their path (sent with the message) and their name (preview
// via /uploads/<name>).

import { effectScope, reactive, nextTick } from 'vue'
import { watch } from '@vue/reactivity'
import { refLine } from '../../shared/reference'
import type { AttachKind } from '../../shared/attachments'
import { mergeKeys } from '../utils/agentIdentity'
import { machineOf } from '../../shared/ids'

export interface DraftAtt {
  url: string // preview: local blob while the page lives, otherwise /uploads/<name> ('' for a file)
  path: string | null // null while the photo is being sent
  name?: string
  // Attached file (PDF, text…): a tile in the field (`head`: a text's first
  // lines), a chip once sent; `ref` is what the message carries (`@<path>` for
  // Claude, the path otherwise).
  file?: { label: string, size: number, kind: AttachKind, head?: string }
  ref?: string
  // Long pasted text (shared/pastedText.ts): a card; sent as it is, after the text.
  paste?: string
  // Upload refused: the reason, shown on the attachment until it is removed (never stored).
  error?: string
  // A photo's original file name (its tile shows it and its extension).
  label?: string
}
type StoredAtt = { path: string, name?: string, file?: DraftAtt['file'], ref?: string, label?: string }

// A stored attachment back into the draft.
export function restoreAtt(a: StoredAtt): DraftAtt {
  return a.file
    ? { url: '', path: a.path, name: a.name, file: a.file, ref: a.ref || a.path }
    : { url: `/uploads/${encodeURIComponent(a.name!)}`, path: a.path, name: a.name, label: a.label }
}
interface Draft { text: string, atts: DraftAtt[] }

const KEY = 'draft:'
// Stored photos are purged after 7 days: we forget them before that.
const ATT_MAX_AGE = 6 * 86400000
const drafts = new Map<string, Draft>()
// The agent keys of each draft's pane (utils/agentIdentity.ts), stored with
// the draft: when Herdr replaces the pane, the new pane of the same agent
// finds the draft by them.
const owners = new Map<string, string[]>()
// Drafts outlive the component. Use the reactivity watcher below: Vue's
// component-aware watch captures the setup instance even in a detached scope.
const scope = effectScope(true)

// Upload date of a photo, read from its name (2026-09-26T00-36-39-393Z-4fa305.jpg).
export function uploadedAt(name: string) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name)
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : 0
}

function load(paneId: string): Draft {
  try {
    const raw = localStorage.getItem(KEY + paneId)
    if (raw) {
      const d = JSON.parse(raw) as { text?: string, atts?: StoredAtt[], pastes?: string[], who?: unknown, reply?: { time?: unknown, excerpt?: unknown } }
      if (Array.isArray(d.who) && !owners.has(paneId)) owners.set(paneId, d.who.filter((k): k is string => typeof k === 'string'))
      // A draft saved while "Replying to the message" was a box above the
      // field: the message it named is now a reference in the text.
      const reply = d.reply && typeof d.reply.time === 'string' && typeof d.reply.excerpt === 'string'
        ? refLine({ kind: 'message', label: '', time: d.reply.time || null, n: null, id: null, excerpt: d.reply.excerpt.replace(/\s+/g, ' ').trim() })
        : ''
      return {
        text: [reply, d.text || ''].filter(Boolean).join('\n'),
        atts: (d.atts || [])
          .filter(a => a.path && a.name && Date.now() - uploadedAt(a.name) < ATT_MAX_AGE)
          .map(restoreAtt)
          .concat((d.pastes || []).filter(p => typeof p === 'string' && p).map(paste => ({ url: '', path: null, paste }))),
      }
    }
  } catch { /* stockage indisponible ou brouillon illisible */ }
  return { text: '', atts: [] }
}

function persist(paneId: string, d: Draft) {
  const atts = d.atts.filter(a => a.path && a.name).map(a => (a.file ? { path: a.path, name: a.name, file: a.file, ref: a.ref } : { path: a.path, name: a.name, label: a.label }))
  const pastes = d.atts.flatMap(a => (a.paste ? [a.paste] : []))
  try {
    if (!d.text && !atts.length && !pastes.length) localStorage.removeItem(KEY + paneId)
    else {
      const who = owners.get(paneId)
      localStorage.setItem(KEY + paneId, JSON.stringify({ text: d.text, atts, pastes: pastes.length ? pastes : undefined, who: who?.length ? who : undefined }))
    }
  } catch { /* stockage indisponible */ }
}

// Reactive draft of the pane: the same object while the page lives, so a
// photo that finishes uploading after a conversation switch lands there.
export function useDraft(paneId: string): Draft {
  let d = drafts.get(paneId)
  if (!d) {
    d = reactive(load(paneId)) as Draft
    drafts.set(paneId, d)
    const draft = d
    let pending = false
    scope.run(() => watch(() => [draft.text, draft.atts.map(a => a.path || (a.paste ? `paste:${a.paste.length}` : '')).join('|')], () => persist(paneId, draft), {
      // Keep persistence batched and let setup/unmount draft restoration finish.
      scheduler(job) {
        if (pending) return
        pending = true
        nextTick(() => { pending = false; job() })
      },
    }))
  }
  return d
}

export const draftFilled = (d: Draft) => Boolean(d.text.trim() || d.atts.length)

// The agent keys stored with the pane's draft (read again after a reload,
// when the pane may already be gone).
export function draftOwnerKeys(paneId: string): string[] {
  useDraft(paneId)
  return [...(owners.get(paneId) || [])]
}

// Record who the pane's agent is (keys only add up: a pane that just closed
// loses its board link before it leaves Herdr's state).
export function noteDraftOwner(paneId: string, keys: readonly string[]) {
  const known = owners.get(paneId) || []
  const next = mergeKeys(known, keys)
  if (next.length === known.length && next.every((k, i) => k === known[i])) return
  owners.set(paneId, next)
  const d = drafts.get(paneId)
  if (d && draftFilled(d)) persist(paneId, d)
}

// The draft of `from` goes into `to`'s field, before what `to` already holds;
// `from` is left empty.
export function moveDraft(from: string, to: string) {
  if (from === to) return
  const a = useDraft(from)
  if (!draftFilled(a)) return
  const b = useDraft(to)
  b.text = [a.text.trim(), b.text.trim()].filter(Boolean).join('\n')
  for (const att of a.atts) {
    if (!b.atts.some(x => (att.path && x.path === att.path) || (att.paste && x.paste === att.paste))) b.atts.push(att)
  }
  a.text = ''
  a.atts.splice(0)
  owners.set(to, mergeKeys(owners.get(to) || [], owners.get(from) || []))
  owners.delete(from)
}

// A draft left by a closed pane of the same agent (one of `keys`, on the same
// machine, its pane no longer in `live`) comes into `paneId`'s field.
// Returns how many drafts came in.
export function adoptDrafts(paneId: string, keys: readonly string[], live: ReadonlySet<string>): number {
  if (!keys.length) return 0
  const machine = machineOf(paneId)
  const ids = new Set<string>(drafts.keys())
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(KEY)) ids.add(k.slice(KEY.length))
    }
  } catch { /* stockage indisponible */ }
  let n = 0
  for (const id of ids) {
    if (id === paneId || live.has(id) || machineOf(id) !== machine) continue
    if (!owners.has(id) && !drafts.has(id)) load(id)
    if (!(owners.get(id) || []).some(k => keys.includes(k))) continue
    if (!draftFilled(useDraft(id))) continue
    moveDraft(id, paneId)
    n++
  }
  return n
}

// The draft as plain text (copied from a closed pane): its text, its pasted
// texts, then what its attachments send (path or reference).
export function draftAsText(d: Draft): string {
  return [
    d.text.trim(),
    ...d.atts.flatMap(a => (a.paste ? [a.paste] : [])),
    ...d.atts.flatMap(a => (a.paste || !a.path ? [] : [a.file ? (a.ref || a.path) : a.path])),
  ].filter(Boolean).join('\n\n')
}
