// The props of one attachment's tile (AttachTile), shared by the message
// field and sent messages so both look the same: a photo, a file, pasted text.
import { attachmentIcon, extensionOf, formatSize, type AttachKind } from '#shared/attachments'
import { lineCount, looksLikeLog, splitPasted } from '#shared/pastedText'
import { sentPastes } from '~/utils/sentPastes'

// A text's first lines, as the tile's preview.
export const firstLines = (s: string) => s.split('\n').slice(0, 10).map(l => l.slice(0, 80)).join('\n')
const badgeOf = (name: string, fallback: string) => extensionOf(name).slice(0, 5).toUpperCase() || fallback

export function pasteTile(text: string) {
  const n = lineCount(text)
  return { name: t('Pasted text'), badge: looksLikeLog(text) ? 'LOG' : 'TXT', description: `${n} line${n > 1 ? 's' : ''}`, text: firstLines(text), label: tl('Open pasted text', 'Ouvrir le texte collé') }
}

export function fileTile(name: string, kind?: AttachKind, size?: number, head?: string) {
  return { name, badge: badgeOf(name, kind === 'text' ? 'TXT' : 'FILE'), description: size ? formatSize(size) : undefined, text: head, icon: attachmentIcon(name, kind) }
}

// A photo in the message field: its name, else "Photo".
export function photoTile(name?: string) {
  return { name: name || t('Photo'), badge: badgeOf(name || '', 'JPG'), label: t('View image') }
}

// A sent message's own words and its long pasted texts (the bubble, the tiles above it).
export const sentSplit = (text: string, pasted?: string[]) => splitPasted(text, pasted, sentPastes.value)
