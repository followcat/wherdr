// "Cancel" of a message not sent: how to put it back into the input field
// (text + attached photos).
import type { DraftAtt } from '../composables/useDraft'
import { parseReply } from '../../shared/replyQuote'
import { refLine } from '../../shared/reference'
import { extensionOf, parseAttachmentLine } from '../../shared/attachments'
import { splitPasted } from '../../shared/pastedText'
import { isUploadLine } from '../../shared/queuedMatch'
import { sentPastes } from './sentPastes'
import { tl } from './i18n'

// Puts a cancelled message back into the draft, as if it had never been
// sent: its text before what was already typed, its attached photos.
// `pasted`: the pasted texts the server lists for it (sent from another device).
// `after`: a message the server gives back goes after what
// was already typed.
export function restoreDraft(draft: { text: string, atts: DraftAtt[] }, message: string, pasted: string[] = [], after = false) {
  // A reply marker of an earlier version comes back as a reference.
  const old = parseReply(message)
  if (old) message = `${refLine({ kind: 'message', label: '', time: old.reply.time, n: null, id: null, excerpt: old.reply.excerpt })}\n${old.body}`
  // Texts sent as "Pasted text" cards become cards again.
  const split = splitPasted(String(message || ''), pasted, sentPastes.value, true)
  for (const paste of split.pastes) draft.atts.push({ url: '', path: null, paste })
  const lines = split.text.split('\n')
  const photos = lines.filter(isUploadLine).map(l => l.trim())
  const files = lines.filter(l => parseAttachmentLine(l))
  const text = lines.filter(l => !isUploadLine(l) && !parseAttachmentLine(l)).join('\n').trim()
  draft.text = (after ? [draft.text.trim(), text] : [text, draft.text.trim()]).filter(Boolean).join('\n')
  for (const path of photos) {
    if (draft.atts.some(a => a.path === path)) continue
    const name = path.split('/').pop()!
    draft.atts.push({ url: `/uploads/${encodeURIComponent(name)}`, path, name })
  }
  // Attached files (size unknown here: the chip shows the name only).
  for (const line of files) {
    const f = parseAttachmentLine(line)!
    if (draft.atts.some(a => a.path === f.path)) continue
    const ext = extensionOf(f.name)
    const kind = ext === 'pdf' ? 'pdf' : ext === 'ipynb' ? 'notebook' : 'text'
    draft.atts.push({ url: '', path: f.path, name: f.path.split('/').pop()!, file: { label: f.name, size: 0, kind }, ref: line.trim() })
  }
}

// Photos that could not come back with a cancelled or stopped message: Claude
// Code keeps no copy of an image it queued, only "[Image #1]".
export function lostPhotosText(n: number): string {
  return n > 1
    ? tl(`${n} images could not be recovered: Claude keeps no copy of them. Attach them again.`, `${n} images n’ont pas pu être récupérées : Claude n’en garde pas de copie. Joins-les à nouveau.`)
    : tl('1 image could not be recovered: Claude keeps no copy of it. Attach it again.', '1 image n’a pas pu être récupérée : Claude n’en garde pas de copie. Joins-la à nouveau.')
}
