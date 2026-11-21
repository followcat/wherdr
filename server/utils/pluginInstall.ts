// wherdr plugins installed from GitHub: owner/repo pinned to one commit.
// Read through the GitHub API (contents listing) and raw.githubusercontent.com,
// no git needed. Only manifest.json and the plain files of the plugin's folder
// are kept; the install is written to a temp folder, then renamed into place.
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { HerdrError } from './herdr'
import { PLUGINS_DIR, readSource } from './clientPlugins'
import { PLUGIN_FILE_RE, PLUGIN_ID_RE, SOURCE_FILE, parseManifest, type ClientPluginInfo, type PluginSource } from '../../shared/clientPlugins'

export interface GitHub { api: string, raw: string, fetch: typeof fetch }
export const GITHUB: GitHub = { api: 'https://api.github.com', raw: 'https://raw.githubusercontent.com', fetch: (...a) => fetch(...a) }

export const MAX_FILES = 50
export const MAX_BYTES = 5 * 1024 * 1024
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/
const SHA_RE = /^[0-9a-f]{40}$/

const fail = (msg: string) => new HerdrError('plugin_install', msg)

// "owner/repo", "owner/repo@v1.2.0", "owner/repo@main" or "owner/repo@<commit>".
export function parsePluginSpec(spec: string): { repo: string, ref: string } | null {
  const s = spec.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  const at = s.indexOf('@')
  const repo = at < 0 ? s : s.slice(0, at)
  const ref = at < 0 ? '' : s.slice(at + 1)
  if (!REPO_RE.test(repo) || (ref && (!REF_RE.test(ref) || ref.includes('..')))) return null
  return { repo, ref }
}

async function get(gh: GitHub, url: string): Promise<Response | null> {
  let r: Response
  try { r = await gh.fetch(url, { headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'wherdr' }, signal: AbortSignal.timeout(20_000) }) }
  catch { throw fail('Could not reach GitHub. Check the network and try again.') }
  if (r.status === 404 || r.status === 422) return null
  if (r.status === 403 || r.status === 429) throw fail('GitHub refused the request (rate limit). Try again later.')
  if (!r.ok) throw fail(`GitHub answered ${r.status}.`)
  return r
}
const getJson = async (gh: GitHub, url: string): Promise<any> => (await get(gh, url))?.json() ?? null
const notFound = (repo: string, ref: string) => fail(`Not found: ${repo}${ref ? `@${ref}` : ''}. The repository may be private, or the branch, tag or commit may not exist.`)

// The commit to install: the ref given, else the latest release tag, else the default branch.
async function resolveRef(gh: GitHub, repo: string, ref: string): Promise<{ resolved: string, commit: string }> {
  let resolved = ref
  if (!resolved) {
    const meta = await getJson(gh, `${gh.api}/repos/${repo}`)
    if (!meta) throw notFound(repo, ref)
    const rel = await getJson(gh, `${gh.api}/repos/${repo}/releases/latest`)
    resolved = String(rel?.tag_name || meta.default_branch || '')
  }
  const c = await getJson(gh, `${gh.api}/repos/${repo}/commits/${encodeURIComponent(resolved)}`)
  if (!c || !SHA_RE.test(String(c.sha))) throw notFound(repo, ref)
  return { resolved, commit: String(c.sha) }
}

// GitHub serves a fork's commit under the parent's name too: the commit must be
// on the branch or tag asked for; a commit given alone, on any branch or tag of
// the repository (the latest release and the default branch first, then every
// branch and tag). `behind` is fine, the branch may have moved on.
async function reachable(gh: GitHub, repo: string, ref: string, commit: string) {
  const on = async (base: string) => {
    const c = await getJson(gh, `${gh.api}/repos/${repo}/compare/${encodeURIComponent(base)}...${commit}`)
    return c?.status === 'identical' || c?.status === 'behind'
  }
  if (ref && !/^[0-9a-f]{7,40}$/.test(ref)) {
    if (await on(ref)) return
    throw fail(`Commit ${commit.slice(0, 12)} is not on ${ref} of ${repo} (it may come from a fork).`)
  }
  const names = (l: unknown) => (Array.isArray(l) ? l.map(x => x?.name).filter((n): n is string => typeof n === 'string' && n !== '') : [])
  const meta = await getJson(gh, `${gh.api}/repos/${repo}`)
  const rel = await getJson(gh, `${gh.api}/repos/${repo}/releases/latest`)
  const tried = new Set<string>()
  const check = async (list: string[]) => {
    for (const base of list) {
      if (tried.has(base)) continue
      tried.add(base)
      if (await on(base)) return true
    }
    return false
  }
  if (await check([rel?.tag_name, meta?.default_branch].filter((b): b is string => typeof b === 'string' && b !== ''))) return
  // Every page, each compared before the next is fetched (a rate limit stops it with its own error).
  for (const kind of ['branches', 'tags']) {
    for (let page = 1; ; page++) {
      const list = names(await getJson(gh, `${gh.api}/repos/${repo}/${kind}?per_page=100&page=${page}`))
      if (await check(list)) return
      if (list.length < 100) break
    }
  }
  throw fail(`Commit ${commit.slice(0, 12)} is not on a branch or tag of ${repo} (it may come from a fork).`)
}

interface Entry { name: string, path: string, type: string, size: number }
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

// The plugin id: the manifest's `id`, else the repository's name.
function pluginId(raw: Record<string, unknown>, repo: string): string {
  if (typeof raw.id === 'string' && PLUGIN_ID_RE.test(raw.id)) return raw.id
  return repo.split('/')[1]!.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64)
}

// Reads the manifest and lists the files to install, without downloading them.
async function inspect(gh: GitHub, repo: string, commit: string) {
  const list = async (dir: string): Promise<Entry[]> => {
    const l = await getJson(gh, `${gh.api}/repos/${repo}/contents${dir ? `/${encPath(dir)}` : ''}?ref=${commit}`)
    if (!Array.isArray(l)) throw fail(dir ? `No folder "${dir}" in ${repo}.` : notFound(repo, commit).message)
    return l
  }
  const root = await list('')
  const m = root.find(e => e.name === 'manifest.json' && e.type === 'file')
  if (!m) throw fail(`No manifest.json at the root of ${repo}.`)
  let raw: Record<string, unknown>
  try { raw = JSON.parse((await download(gh, repo, commit, m, 64 * 1024)).toString('utf8')) } catch (e) { throw e instanceof HerdrError ? e : fail('manifest.json is not valid JSON.') }
  if (!raw || typeof raw !== 'object') throw fail('manifest.json is not valid JSON.')
  const folder = typeof raw.folder === 'string' ? raw.folder.replace(/^\/+|\/+$/g, '') : ''
  if (folder && folder.split('/').some(p => !PLUGIN_FILE_RE.test(p))) throw fail(`Bad folder in manifest.json: "${folder}".`)
  const entries: Entry[] = []
  for (const e of folder ? await list(folder) : root) {
    if (e.name.includes('/') || e.name === '.' || e.name === '..') throw fail(`Bad file name: "${e.name}".`)
    if (e.type === 'symlink') throw fail(`Links are not allowed: "${e.name}".`)
    // Sub-folders (sources, docs…) and dot files are not part of the plugin.
    if (e.type !== 'file' || !PLUGIN_FILE_RE.test(e.name) || e.name === 'manifest.json') continue
    entries.push(e)
  }
  if (entries.length >= MAX_FILES) throw fail(`Too many files (${MAX_FILES} max).`)
  if (entries.reduce((n, e) => n + (e.size || 0), m.size || 0) > MAX_BYTES) throw fail('The plugin is too big (5 MB max).')
  const id = pluginId(raw, repo)
  const info = parseManifest(id, raw)
  if (!info) throw fail('manifest.json is not a valid plugin manifest.')
  if (!entries.some(e => e.name === info.main)) throw fail(`The plugin's file ${info.main} is missing${folder ? ` from ${folder}/` : ''}.`)
  return { info, manifest: m, entries }
}

async function download(gh: GitHub, repo: string, commit: string, e: Entry, max: number): Promise<Buffer> {
  const r = await get(gh, `${gh.raw}/${repo}/${commit}/${encPath(e.path)}`)
  if (!r) throw fail(`Could not download ${e.path}.`)
  // Read in chunks and stop past the cap, whatever size the listing claimed.
  const chunks: Buffer[] = []
  let n = 0
  const reader = r.body?.getReader()
  for (let c = await reader?.read(); c && !c.done; c = await reader!.read()) {
    n += c.value.length
    if (n > max) { await reader!.cancel().catch(() => {}); throw fail('The plugin is too big (5 MB max).') }
    chunks.push(Buffer.from(c.value))
  }
  return Buffer.concat(chunks)
}

// A plugin folder that exists and was not installed from this repository.
async function clash(dir: string, id: string, repo: string) {
  try { await fsp.access(path.join(dir, id)) } catch { return }
  const src = await readSource(dir, id)
  if (!src || src.repo.toLowerCase() !== repo.toLowerCase()) throw fail(`A plugin "${id}" is already installed from somewhere else. Remove it first.`)
}

export interface Preview extends ClientPluginInfo { source: PluginSource, resolved: string, update: boolean }

export async function previewFromGitHub(spec: string, gh = GITHUB, dir = PLUGINS_DIR): Promise<Preview> {
  const p = parsePluginSpec(spec)
  if (!p) throw fail('Type owner/repo, optionally followed by @tag, @branch or @commit.')
  const { resolved, commit } = await resolveRef(gh, p.repo, p.ref)
  await reachable(gh, p.repo, p.ref, commit)
  const { info } = await inspect(gh, p.repo, commit)
  await clash(dir, info.id, p.repo)
  const installed = await readSource(dir, info.id)
  return { ...info, source: { repo: p.repo, ref: p.ref, commit }, resolved, update: Boolean(installed) }
}

// One install or removal at a time per plugin folder: the clash check and the
// swap see the same folder (two repos with the same id cannot both pass).
const locks = new Map<string, Promise<unknown>>()
async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  locks.set(key, tail)
  try { return await run } finally { if (locks.get(key) === tail) locks.delete(key) }
}

export async function installFromGitHub(source: PluginSource, gh = GITHUB, dir = PLUGINS_DIR): Promise<ClientPluginInfo> {
  if (!parsePluginSpec(source.repo + (source.ref ? `@${source.ref}` : '')) || !SHA_RE.test(source.commit)) throw fail('Bad source.')
  await reachable(gh, source.repo, source.ref, source.commit)
  const { info, manifest, entries } = await inspect(gh, source.repo, source.commit)
  return locked(path.join(dir, info.id), () => write(source, info, [manifest, ...entries], gh, dir))
}

// What a crash mid-install left for this id: the plugin moved aside and never
// moved back is restored, temp folders are removed. Runs under the id's lock.
async function sweep(dir: string, id: string) {
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  const dest = path.join(dir, id)
  for (const n of names) {
    const old = n.startsWith(`.old-${id}-`) && /^[0-9a-f]{8}$/.test(n.slice(`.old-${id}-`.length))
    if (!old && !(n.startsWith(`.install-${id}-`) && /^[0-9a-f]{8}$/.test(n.slice(`.install-${id}-`.length)))) continue
    if (old && await fsp.rename(path.join(dir, n), dest).then(() => true, () => false)) continue
    await fsp.rm(path.join(dir, n), { recursive: true, force: true })
  }
}

async function write(source: PluginSource, info: ClientPluginInfo, todo: Entry[], gh: GitHub, dir: string): Promise<ClientPluginInfo> {
  await sweep(dir, info.id)
  await clash(dir, info.id, source.repo)
  let left = MAX_BYTES
  const files: [string, Buffer][] = []
  for (const e of todo) {
    const buf = await download(gh, source.repo, source.commit, e, left)
    left -= buf.length
    files.push([e.name, buf])
  }
  await fsp.mkdir(dir, { recursive: true })
  const tag = randomBytes(4).toString('hex')
  const tmp = path.join(dir, `.install-${info.id}-${tag}`)
  const old = path.join(dir, `.old-${info.id}-${tag}`)
  const dest = path.join(dir, info.id)
  try {
    await fsp.mkdir(tmp)
    for (const [name, buf] of files) await fsp.writeFile(path.join(tmp, name), buf)
    await fsp.writeFile(path.join(tmp, SOURCE_FILE), JSON.stringify({ repo: source.repo, ref: source.ref, commit: source.commit }) + '\n')
    const had = await fsp.rename(dest, old).then(() => true, () => false)
    try { await fsp.rename(tmp, dest) } catch (e) { if (had) await fsp.rename(old, dest); throw e }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
    await fsp.rm(old, { recursive: true, force: true })
  }
  return { ...info, source }
}

// A newer commit for the plugin's ref (and its version), or `null` when it is up to date.
export async function checkPluginSource(id: string, gh = GITHUB, dir = PLUGINS_DIR): Promise<Preview | null> {
  const src = PLUGIN_ID_RE.test(id) ? await readSource(dir, id) : null
  if (!src) throw fail('This plugin was not installed from GitHub.')
  const { resolved, commit } = await resolveRef(gh, src.repo, src.ref)
  if (commit === src.commit) return null
  const { info } = await inspect(gh, src.repo, commit)
  if (info.id !== id) throw fail(`The new version has another id (${info.id}). Remove this plugin and install it again.`)
  return { ...info, source: { ...src, commit }, resolved, update: true }
}

export async function removeClientPlugin(id: string, dir = PLUGINS_DIR) {
  if (!PLUGIN_ID_RE.test(id)) throw fail('Bad plugin id.')
  await locked(path.join(dir, id), () => fsp.rm(path.join(dir, id), { recursive: true, force: true }))
}
