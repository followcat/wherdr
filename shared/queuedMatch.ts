// Photos of a queued message. A message sent from wherdr carries its photos
// as path lines ("<home>/.cache/herdr-web/uploads/<name>"); the agent turns
// them into images (Claude Code writes "[Image #1]" in its own queue and the
// image itself in the transcript). A message with photos and no text has
// nothing else to be recognized by: it is matched by its photos.

const UPLOAD = '/.cache/herdr-web/uploads/'
export const isUploadLine = (l: string) => l.includes(UPLOAD)

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
