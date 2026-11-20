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
// only matched exactly: what it stands for is unknown. Claude draws its
// "[Image #N]" tags before the text, wherever the photo lines were (wherdr
// sends them last): only their count is compared, not their place (WHR-440).
const tagsFirst = (t: string, n: number) => '[Image]'.repeat(n) + t.replace(IMAGE_TAG, '').replace(/\s+/g, '')
const fieldForm = (t: string) => tagsFirst(String(t || ''), imageTagCount(t))
// The conversation's own matching (`loose`): photos left out on both sides.
// Claude's field may show fewer "[Image #N]" than the message has photo lines
// (a photo it did not turn into an image, or a tag drawn on another line);
// counting them would show the same message twice, once sent, once "Not sent".
// The server keeps counting them: it waits for every photo before Enter.
// Claude may also leave a photo there as its path, not yet (or never) turned
// into "[Image #N]", from the home folder or as "~/…" (WHR-398): left out too.
const PHOTO_PATH = /(?:~|\/)\S*\/(?:\.cache\/herdr-web\/uploads\/\S+|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}\.(?:jpg|png|webp|gif|heic))/g
const looseForm = (t: string) => String(t || '').replace(IMAGE_TAG, '').replace(PHOTO_PATH, '').replace(/\s+/g, '')
const PASTE_TAG = /\[Pasted text #\d+(?: \+\d+ lines)?\]/
const messageForm = (text: string) => tagsFirst(withoutUploads(text), uploadNames(text).length + imageTagCount(text))
// Claude's field holds this message alone with at least one photo still as
// its path (the others as "[Image #N]"), the lone "\" aside: Claude took the
// path as typed text and will not turn it into an image any more (WHR-454).
// Collapsed into "[Pasted text #N +K lines]", the paths are not on screen: a
// photo missing from its "[Image #N]" tags is inside it as its path (Claude
// turns them into images when it takes the paste, never later; WHR-472).
export function fieldHoldsRawPhoto(field: string | null | undefined, text: string): boolean {
  const f = String(field || '').replace(/\\\s*$/, '')
  if (PASTE_TAG.test(f)) return imageTagCount(f) < uploadNames(text).length && fieldHolds(f, text, true, true)
  const raw = (f.match(PHOTO_PATH) || []).length
  return raw > 0 && raw + imageTagCount(f) === uploadNames(text).length
    && looseForm(f) === looseForm(withoutUploads(text))
}
// Why a field does not hold a message, for the server log: sizes, never text.
export const fieldGap = (field: string, text: string) =>
  `${fieldForm(field).length} chars, ${imageTagCount(field)} images${PASTE_TAG.test(field) ? ', a paste stand-in' : ''}; expected ${messageForm(text).length} chars, ${uploadNames(text).length} images, ${text.split('\n').length} lines`
export function fieldHolds(field: string | null | undefined, text: string, exact = false, loose = false): boolean {
  // The lone "\" a photo message is sent with (holdEnter in coreInput.ts), left
  // there when Claude dropped core's Enter: not part of the message. Only a
  // photo message gets one: a message of its own ending with "\" keeps it.
  field = String(field || '')
  if (uploadNames(text).length) field = field.replace(/\\\s*$/, '')
  // Photos alone: only their tags tell them apart, so they are counted.
  const free = loose && Boolean(withoutUploads(text))
  const form = free ? looseForm : fieldForm
  const m = free ? looseForm(withoutUploads(text)) : messageForm(text)
  const parts = String(field || '').split(PASTE_TAG).map(form)
  if (!m || !form(field || '')) return false
  if (parts.length === 1) return exact ? parts[0] === m : m.length > 0 && parts[0]!.startsWith(m)
  // One paste stand-in, for a multi-line message: the text around it is ours,
  // and it stands for at least one character of it. The server's own match
  // (exact, not loose) counts the photos' tags: one missing is a path inside
  // the stand-in (fieldHoldsRawPhoto).
  if (parts.length !== 2 || !withoutUploads(text).includes('\n')) return false
  if (exact && !loose && imageTagCount(field) !== uploadNames(text).length + imageTagCount(text)) return false
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
