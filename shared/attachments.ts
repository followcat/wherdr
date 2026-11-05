// Files attached to a message (not only photos): what each agent can read,
// size limits, safe stored names and the reference written in the message.
// Pure, shared by the composer (checks before upload) and the server (the
// authority: same checks on the received bytes).
//
// What the agents read from a path given in a message (checked on Claude Code
// 2.1 and Codex CLI 0.159):
// - Claude Code: its Read tool opens images, PDFs (by page ranges), Jupyter
//   notebooks and any text file whatever its extension. `@<path>` puts a text
//   file's content in the conversation directly (documented "Reference files");
//   PDFs keep a plain path so Claude reads them page by page.
// - Codex: images (attached when their path is pasted, or `--image`) and text
//   files it opens with its shell tools. No PDF reader: refused.
// - Other agents (omp…): images and text, like Codex.

export type AttachKind = 'image' | 'pdf' | 'notebook' | 'text'
export type RefuseReason = 'archive' | 'video' | 'audio' | 'office' | 'executable' | 'binary' | 'pdf' | 'too_large' | 'empty'

export const ATTACH_LIMITS: Record<AttachKind, number> = {
  image: 20 * 1024 * 1024,
  pdf: 30 * 1024 * 1024,
  notebook: 20 * 1024 * 1024,
  text: 10 * 1024 * 1024,
}
// Largest body the upload route accepts (the biggest limit above).
export const ATTACH_MAX = Math.max(...Object.values(ATTACH_LIMITS))
// Bytes read to tell text from binary (like git: a NUL byte means binary).
export const SNIFF_BYTES = 8192

const EXT_GROUPS: Record<Exclude<RefuseReason, 'binary' | 'pdf' | 'too_large' | 'empty'>, string[]> = {
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'txz', 'zst', '7z', 'rar', 'lz', 'lzma', 'z', 'cab', 'jar', 'war', 'ear', 'dmg', 'iso', 'img', 'pkg', 'deb', 'rpm', 'apk', 'ipa', 'xip', 'whl', 'nupkg', 'crx'],
  video: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ogv', 'mts'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'wma', 'mid', 'midi', 'caf'],
  office: ['doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'epub'],
  executable: ['exe', 'dll', 'so', 'dylib', 'bin', 'app', 'msi', 'class', 'o', 'a', 'lib', 'obj', 'wasm', 'pyc', 'pyo', 'elf', 'com', 'scr'],
}
const EXT_REFUSED = new Map<string, RefuseReason>()
for (const [reason, exts] of Object.entries(EXT_GROUPS)) for (const e of exts) EXT_REFUSED.set(e, reason as RefuseReason)
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'avif'])

export function extensionOf(name: string): string {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

// Text = no NUL byte and valid UTF-8 (a character cut by the end of the
// sample is tolerated).
export function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false
  for (let cut = 0; cut <= 3 && cut < head.length; cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - cut))
      return true
    } catch { /* maybe a character cut at the end */ }
  }
  return head.length === 0
}

const isPdf = (head: Uint8Array) => head.length >= 5 && String.fromCharCode(...head.subarray(0, 5)) === '%PDF-'

export type Classified = { kind: AttachKind } | { refused: RefuseReason }

// What the file is, from its name, its MIME type and its first bytes.
// SVG is text (XML), not an image to shrink.
export function classifyAttachment(name: string, mime: string, head: Uint8Array): Classified {
  const ext = extensionOf(name)
  const type = String(mime || '').toLowerCase()
  const listed = EXT_REFUSED.get(ext)
  if (listed) return { refused: listed }
  if (type.startsWith('video/')) return { refused: 'video' }
  if (type.startsWith('audio/')) return { refused: 'audio' }
  if (ext === 'pdf' || type === 'application/pdf') return isPdf(head) ? { kind: 'pdf' } : { refused: 'binary' }
  if (ext !== 'svg' && type !== 'image/svg+xml' && (IMAGE_EXT.has(ext) || type.startsWith('image/'))) return { kind: 'image' }
  if (!looksLikeText(head)) return { refused: 'binary' }
  return { kind: ext === 'ipynb' ? 'notebook' : 'text' }
}

export function agentReads(agent: string | null | undefined, kind: AttachKind): boolean {
  if (kind === 'pdf') return agent === 'claude'
  return true
}

export type AttachCheck = { ok: true, kind: AttachKind } | { ok: false, reason: RefuseReason, kind?: AttachKind }

// Full check of a file for an agent: kind, agent support, size.
export function checkAttachment(agent: string | null | undefined, file: { name: string, type: string, size: number }, head: Uint8Array): AttachCheck {
  if (!file.size) return { ok: false, reason: 'empty' }
  const c = classifyAttachment(file.name, file.type, head)
  if ('refused' in c) return { ok: false, reason: c.refused }
  if (!agentReads(agent, c.kind)) return { ok: false, reason: c.kind === 'pdf' ? 'pdf' : 'binary', kind: c.kind }
  if (file.size > ATTACH_LIMITS[c.kind]) return { ok: false, reason: 'too_large', kind: c.kind }
  return { ok: true, kind: c.kind }
}

// Name kept on disk: the original's base name, reduced to letters, digits,
// ".", "_" and "-" (no path, no space, no hidden file), 80 characters max
// with its extension.
export function safeAttachmentName(original: string): string {
  const clean = (x: string) => x.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._-]+/, '').replace(/[._-]+$/, '')
  const base = String(original || '').split(/[\\/]/).pop() || ''
  const rawExt = extensionOf(base)
  const ext = /^[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : ''
  let stem = clean(ext ? base.slice(0, -(rawExt.length + 1)) : base)
  if (!stem) stem = 'file'
  const tail = ext ? `.${base.slice(-ext.length)}` : ''
  return stem.slice(0, 80 - tail.length).replace(/[._-]+$/, '') + tail
}

// "<date>-<6 hex>-<name>": unique, sorted by date, original name readable.
export function storedAttachmentName(original: string, now: Date, rand: string): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${rand}-${safeAttachmentName(original)}`
}
export const STORED_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}-[A-Za-z0-9][\w.-]*$/
export const isStoredAttachmentName = (name: string) => STORED_NAME_RE.test(name) && !name.includes('..')

// Name shown on the chip: without the date and random prefix.
export function attachmentDisplayName(stored: string): string {
  const base = String(stored || '').split('/').pop() || ''
  return base.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}-/, '')
}

// Reference written in the message: `@<path>` puts a text file's content in
// Claude's context; anything else goes as a plain path the agent opens.
export function attachmentRef(agent: string | null | undefined, kind: AttachKind, path: string): string {
  return agent === 'claude' && (kind === 'text' || kind === 'notebook') ? `@${path}` : path
}

// A message line that is only an attached file (with or without "@").
const LINE_RE = /^@?(\/\S*\/\.cache\/herdr-web\/files\/[^\s/]+)$/
export function parseAttachmentLine(line: string): { path: string, name: string } | null {
  const m = LINE_RE.exec(String(line || '').trim())
  return m ? { path: m[1]!, name: attachmentDisplayName(m[1]!) } : null
}
export const isAttachmentLine = (line: string) => parseAttachmentLine(line) !== null

// Icon of a chip, by kind / extension.
export function attachmentIcon(name: string, kind?: AttachKind): string {
  const ext = extensionOf(name)
  if (kind === 'pdf' || ext === 'pdf') return 'i-lucide-file-text'
  if (kind === 'notebook' || ext === 'ipynb') return 'i-lucide-notebook-pen'
  if (kind === 'image') return 'i-lucide-file-image'
  if (['json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv', 'ini', 'env'].includes(ext)) return 'i-lucide-file-json'
  if (['md', 'txt', 'rst', 'log', 'adoc', ''].includes(ext)) return 'i-lucide-file-type'
  return 'i-lucide-file-code'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

// A message ending with "@<path>" leaves Claude Code's path suggestions open:
// the Enter that should send it picks a suggestion instead and the message
// stays in the input (checked on Claude Code 2.1). A trailing space closes them.
export function closeTrailingMention(text: string): string {
  return /(^|\n)@\S+$/.test(text) ? `${text} ` : text
}
