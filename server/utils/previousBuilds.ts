// The /_nuxt files of the previous builds, still served after an update: a
// page opened before the deployment, or started from the phone's cached shell
// (Settings › Phone › App start › Instant), loads its lazy chunks by their old
// names, which the new package no longer ships. Without them the chunk fails
// and the app reloads itself (app/plugins/app-version.client.ts); with them,
// that reload stays a rare fallback.
//
// At startup the current build's files are linked (or copied, across disks)
// into DATA_DIR/builds/<build id>/, outside the package an update replaces.
// Kept: the current build and the two before it. A count rather than a
// duration: a phone can stay closed for days between deployments (a 24 h rule
// would drop the build its cached shell names), while a busy day of
// deployments would make a duration keep many. Two cover a phone that missed
// one deployment and the one in between, for a few MB each when copied.
import fs from 'node:fs'
import path from 'node:path'

export const KEPT_PREVIOUS_BUILDS = 2
const META = 'build.json'

// The built app's public folder (.output/public), found from the server's own
// file; none in development (nothing to keep).
export function builtPublicDir(from: string): string | null {
  let dir = path.dirname(from)
  for (let i = 0; i < 6; i++) {
    const pub = path.join(dir, 'public')
    if (fs.existsSync(path.join(pub, '_nuxt', 'builds', 'latest.json'))) return pub
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

export function currentBuildId(publicDir: string): string | null {
  try {
    const id = JSON.parse(fs.readFileSync(path.join(publicDir, '_nuxt', 'builds', 'latest.json'), 'utf8'))?.id
    return typeof id === 'string' && /^[\w-]+$/.test(id) ? id : null
  } catch { return null }
}

// The build's files, without Nuxt's build manifests (builds/) and the
// compressed twins (.gz, .br): the fallback serves the plain file.
function copyBuild(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'builds') copyBuild(from, to) }
    else if (entry.isFile() && !/\.(gz|br)$/.test(entry.name)) {
      try { fs.linkSync(from, to) }
      catch { fs.copyFileSync(from, to) }
    }
  }
}

function keptBuilds(store: string): Array<{ id: string, at: number }> {
  let names: string[] = []
  try { names = fs.readdirSync(store) } catch { return [] }
  return names.flatMap((id) => {
    try {
      const at = JSON.parse(fs.readFileSync(path.join(store, id, META), 'utf8'))?.at
      return typeof at === 'number' ? [{ id, at }] : []
    } catch { return [] }
  }).sort((a, b) => b.at - a.at)
}

// Keeps the current build, drops what is past the retention (and unfinished
// copies), and returns the previous builds' folders, newest first.
export function keepBuild(publicDir: string, store: string, id: string, now = Date.now()): string[] {
  const dir = path.join(store, id)
  if (!fs.existsSync(path.join(dir, META))) {
    const tmp = path.join(store, `.${id}-${process.pid}`)
    fs.rmSync(tmp, { recursive: true, force: true })
    copyBuild(path.join(publicDir, '_nuxt'), tmp)
    fs.writeFileSync(path.join(tmp, META), JSON.stringify({ at: now }))
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(tmp, dir)
  }
  const previous = keptBuilds(store).filter(b => b.id !== id)
  const keep = new Set(previous.slice(0, KEPT_PREVIOUS_BUILDS).map(b => b.id))
  for (const name of fs.readdirSync(store)) {
    if (name !== id && !keep.has(name)) fs.rmSync(path.join(store, name), { recursive: true, force: true })
  }
  return previous.filter(b => keep.has(b.id)).map(b => path.join(store, b.id))
}

// A /_nuxt file the current build lacks, from the newest previous build that
// has it; null otherwise (or for a path that would leave the build folder).
export function previousBuildFile(dirs: readonly string[], rel: string): string | null {
  const parts = rel.split('/')
  if (!parts.length || parts.some(p => !/^[\w.-]+$/.test(p) || p === '.' || p === '..') || parts[0] === META) return null
  for (const dir of dirs) {
    const file = path.join(dir, ...parts)
    try { if (fs.statSync(file).isFile()) return file } catch { /* not in this build */ }
  }
  return null
}

// Filled at startup (server/plugins/previousBuilds.ts), read by
// server/routes/_nuxt/[...path].get.ts.
export const previousBuildDirs: string[] = []
