// Photos of a queued message. A message sent from wherdr carries its photos
// as path lines: "<home>/.cache/herdr-web/uploads/<name>", or on herdr-core
// the path `terminal.put` returned (its own folder, on the agent's machine),
// told apart by the name wherdr gives a photo (see corePutPhoto). The agent
// turns them into images (Claude Code writes "[Image #1]" in its own queue
// and the image itself in the transcript). A message with photos and no text
// has nothing else to be recognized by: it is matched by its photos.

const UPLOAD = '/.cache/herdr-web/uploads/'
const CORE_PHOTO = /^\/\S*\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}\.(?:jpg|png|webp|gif|heic)$/
export const isUploadLine = (l: string) => l.includes(UPLOAD) || CORE_PHOTO.test(l.trim())

// Stored names of the photos of a message.
export function uploadNames(text: string): string[] {
  return String(text || '').split('\n').filter(isUploadLine).map(l => l.trim().split('/').pop()!).filter(Boolean)
}

// Message text without its photo lines.
export const withoutUploads = (text: string) => String(text || '').split('\n').filter(l => !isUploadLine(l)).join('\n').trim()

// Photos only, no text.
export const photosOnly = (text: string) => uploadNames(text).length > 0 && !withoutUploads(text)

// "[Image #1]" (Claude Code), "[Image #1, 756x477]" (omp).
const IMAGE_TAG = /\[Image #\d+(?:, \d+x\d+)?\]/g
export const imageTagCount = (text: string) => (String(text || '').match(IMAGE_TAG) || []).length
// Only image tags (a photos-only message in Claude's queue or on its screen).
export const onlyImageTags = (text: string) => imageTagCount(text) > 0 && !String(text || '').replace(IMAGE_TAG, '').trim()

// Claude's input field holds this message, not sent yet: the field shows each
// of its photo lines as "[Image #N]" (the number grows with the session), a
// long multi-line part as one "[Pasted text #N +K lines]", and wraps it
// (spaces aside). `exact`: the field holds it and nothing else; otherwise it
// starts with it (more text may follow). A field with a paste stand-in is
// only matched exactly: what it stands for is unknown.
const fieldForm = (t: string) => String(t || '').replace(IMAGE_TAG, '[Image]').replace(/\s+/g, '')
const PASTE_TAG = /\[Pasted text #\d+(?: \+\d+ lines)?\]/
export function fieldHolds(field: string | null | undefined, text: string, exact = false): boolean {
  const m = fieldForm(String(text || '').split('\n').map(l => (isUploadLine(l) ? '[Image]' : l)).join('\n'))
  const parts = String(field || '').split(PASTE_TAG).map(fieldForm)
  if (!m || !fieldForm(field || '')) return false
  if (parts.length === 1) return exact ? parts[0] === m : m.length > 0 && parts[0]!.startsWith(m)
  // One paste stand-in, for a multi-line message: the text around it is ours,
  // and it stands for at least one character of it.
  if (parts.length !== 2 || !withoutUploads(text).includes('\n')) return false
  const [before, after] = parts as [string, string]
  return m.length > before.length + after.length && m.startsWith(before) && m.endsWith(after)
}

// A photos-only message taken by the agent: a user message showing one of its
// photos (path kept as text), or carrying images (Claude may group it with
// other queued messages into one turn, so text of its own does not rule it out).
export function photosLanded(text: string, item: { role: string, text: string, images?: number }): boolean {
  if (item.role !== 'user' || !photosOnly(text)) return false
  return uploadNames(text).some(n => item.text.includes(n)) || (item.images || 0) > 0
}

// Address of a stored photo in the app.
export const uploadSrc = (name: string) => `/uploads/${encodeURIComponent(name)}`

// A command for the agent ("/compact", "/model opus"…), not a message that
// starts with a path (a photo sent alone is "/…/uploads/<name>").
export const isSlashCommand = (text: string) => /^\/[^\s/]*(?:\s|$)/.test(String(text || '').trim())

// "!" with nothing after it: Claude Code switches to bash mode with an empty
// field and stays there, so the next message would run as a shell command
// (Claude Code 2.1.318). Nothing to send.
export const isBareBang = (text: string) => /^\s*!\s*$/.test(String(text || ''))
