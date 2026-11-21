// Actions: folders under the home folder, recent folders, photos.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, HOME, UPLOAD_DIR, UPLOAD_TTL_MS } from './env'
import { type Machine, getMachine } from './machines'
import { inProjectsHome } from '../../bin/lib/userpath.mjs'
import { writeJsonAtomic } from './atomicWrite'

const fsp = fs.promises
const px = path.posix

export function underHome(p: unknown, home = HOME): string | null {
  const r = px.resolve(home, String(p || '').replace(/^~(?=$|\/)/, home))
  return r === home || r.startsWith(home + '/') ? r : null
}

// Recent folders (the 30 last, most recent first): `dirs` for the local
// machine (old format), and `machines[<profile id>]` for the others.
const DIRS_FILE = path.join(DATA_DIR, 'dirs.json')
type DirsFile = { dirs?: string[], machines?: Record<string, string[]> }
// `strict` (before a write): only a missing file is empty; an unreadable or
// damaged one throws, never written over with this machine's list alone.
async function readDirsFile(strict = false): Promise<DirsFile> {
  try { return JSON.parse(await fsp.readFile(DIRS_FILE, 'utf8')) || {} }
  catch (e) {
    if (strict && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return {}
  }
}
const dirsKey = (m: DirsOwner) => m.profileId || m.key
export type DirsOwner = Pick<Machine, 'local' | 'key' | 'profileId'>
const dirsOf = (f: DirsFile, m: DirsOwner) => (m.local ? (f.dirs || []).filter(d => !inProjectsHome(d, process.env, HOME)) : (f.machines && f.machines[dirsKey(m)]) || [])
// Never a herdr-projects folder of this machine (a v2 import used to copy them):
// the next folder remembered writes the list without them.
export async function recentDirs(m: DirsOwner = getMachine('')!): Promise<string[]> {
  return dirsOf(await readDirsFile(), m)
}
// One write at a time: two folders remembered together both stay.
let dirsQueue: Promise<unknown> = Promise.resolve()
export function rememberDir(d: string, m: DirsOwner): Promise<void> {
  const run = dirsQueue.then(async () => {
    const f = await readDirsFile(true)
    const dirs = [d, ...dirsOf(f, m).filter(x => x !== d)].slice(0, 30)
    if (m.local) f.dirs = dirs
    else f.machines = { ...(f.machines || {}), [dirsKey(m)]: dirs }
    await writeJsonAtomic(DIRS_FILE, f)
  })
  dirsQueue = run.catch(() => {})
  return run
}

// --- Photos ----------------------------------------------------------------
export const UPLOAD_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' }
export async function cleanUploads() {
  try {
    for (const n of await fsp.readdir(UPLOAD_DIR)) {
      const f = path.join(UPLOAD_DIR, n)
      const st = await fsp.stat(f)
      if (Date.now() - st.mtimeMs > UPLOAD_TTL_MS) await fsp.unlink(f)
    }
  } catch { /* folder missing */ }
}
// Photo already stored, re-read by its name (never outside the store).
export async function readUpload(name: string) {
  if (!/^[\w.-]+\.(jpg|png|webp|gif|heic)$/.test(name)) return null
  const ext = name.split('.').pop()!
  return { type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, body: await fsp.readFile(path.join(UPLOAD_DIR, name)) }
}
