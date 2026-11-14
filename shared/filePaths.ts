// File and folder paths written by agents in their replies, as inline code
// (`~/project/src/app.ts`, `/Users/me/notes.md`, `src/app.ts:42`): detected on
// the client (clickable path, utils/markdown.ts) and resolved on the server
// before it is opened (server/utils/files.ts).

// path.posix.resolve without node:path (this file also runs in the browser).
export function posixResolve(base: string, p: string): string {
  const out: string[] = []
  for (const seg of (p.startsWith('/') ? p : `${base}/${p}`).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

// Bare file names recognized without a folder (`README.md`), by extension:
// a plain `name.ext` would also catch code such as `console.log`.
const FILE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'json', 'jsonl', 'md', 'mdx', 'txt', 'html', 'htm',
  'css', 'scss', 'less', 'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'fish', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'lock', 'xml', 'svg', 'csv',
  'tsv', 'sql', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'm4v', 'mov', 'webm', 'zip', 'gz', 'tgz', 'docx',
  'xlsx', 'pptx', 'ipynb', 'dockerfile', 'patch', 'diff',
])
const KNOWN_NAMES = new Set(['Dockerfile', 'Makefile', 'LICENSE', 'Gemfile', 'Procfile', 'Justfile', '.env', '.gitignore'])

// Characters that never appear in a path an agent shows (shell syntax,
// globs, quotes), or that would make the text something else than a path.
const NOT_PATH = /[\0\n\r\t`"<>|*?$;&{}[\]()\\]|:\/\//
// Trailing position `:42` or `:42:7` (compiler and grep output).
const POSITION = /:\d+(?::\d+)?$/
const SEGMENT = /^[\w@+~.,=%#-]+$/

export const stripPosition = (s: string) => s.replace(POSITION, '')

// Inline code that looks like a file or folder path: absolute, `~/…`, or
// relative (`./x`, `../x`, `dir/file.ext`, `a/b/c`, `dir/`, `README.md`).
// Returns the path without its `:line:col` suffix, or null.
export function pathCandidate(code: string): string | null {
  const raw = String(code || '').trim()
  if (raw.length < 2 || raw.length > 1024 || NOT_PATH.test(raw)) return null
  const p = stripPosition(raw)
  if (p.length < 2 || p.startsWith('-')) return null
  const absolute = p.startsWith('/') || p.startsWith('~/')
  // Spaces only in absolute paths (`/Users/me/My Files/a.txt`): elsewhere they
  // are prose or commands.
  if (/\s/.test(p) && !absolute) return null
  if (/\s{2,}|^\S+\s+-/.test(p)) return null
  const parts = p.replace(/^~\//, '').replace(/^\/+/, '').split('/')
  const segs = parts.filter((s, i) => s !== '' || i !== parts.length - 1)
  if (!segs.length || segs.some(s => s === '' || !SEGMENT.test(s.replace(/ /g, '_')))) return null
  if (absolute) {
    // `/` followed by a lone word (`/model`, `/help`): a slash command, not a path.
    if (p.startsWith('/') && segs.length === 1 && !/\.\w+$/.test(segs[0]!)) return null
    return p
  }
  if (p.startsWith('./') || p.startsWith('../')) return p
  const last = segs[segs.length - 1]!
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(last)?.[1]?.toLowerCase()
  const known = KNOWN_NAMES.has(last) || Boolean(ext && FILE_EXTS.has(ext))
  if (segs.length === 1) return known && !/^\d/.test(last) ? p : null
  // `dir/file.ext`, `dir/` or at least three segments (`a/b/c`); `and/or` is not one.
  if (known || p.endsWith('/') || segs.length >= 3) return segs.every(s => /[A-Za-z_]/.test(s)) ? p : null
  return null
}

// `p` is `root` or lies under it (both absolute and normalized).
export const insideRoot = (root: string, p: string) => p === root || p.startsWith(root === '/' ? '/' : root + '/')

// Absolute path for a path written by an agent: `~` is the machine's home,
// a relative path is relative to the agent's folder (its home when the folder
// is unknown or outside `roots`). Null outside `roots` (the home folder by
// default; shared/chatFiles.ts).
export function resolveAgentPath(written: string, cwd: string | null | undefined, home: string, roots: string[] = [home]): string | null {
  const p = stripPosition(String(written || '').trim())
  if (!p || !home.startsWith('/') || /[\0\n\r]/.test(p)) return null
  const root = posixResolve('/', home)
  const allowed = roots.filter(r => r.startsWith('/')).map(r => posixResolve('/', r))
  const inside = (r: string) => allowed.some(a => insideRoot(a, r))
  const base = cwd && cwd.startsWith('/') && inside(posixResolve('/', cwd)) ? posixResolve('/', cwd) : root
  const r = posixResolve(base, p.replace(/^~(?=$|\/)/, root))
  return inside(r) ? r : null
}
