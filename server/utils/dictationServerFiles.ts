// On-device dictation files the server fetches itself: Install in Settings (or
// the first mic press) asks for a model, and when DATA_DIR/models lacks its
// files (the runtime and the model's set), the server downloads them with the
// fetch script's code: same pinned URLs, sha256 checks and resume. One fetch
// at a time; a second request for the same model joins the first. Admins can
// still run scripts/fetch-dictation-files.mjs by hand.
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { CATALOG, SETS, fetchEntry } from '../../scripts/dictation-files.mjs'
import type { FetchEntry, FetchOptions } from '../../scripts/dictation-files.mjs'
import { HerdrError } from './herdr'

interface CatalogModel { id: string, set: string, dir: string, files: { path: string, bytes: number }[] }

export type ServerFilesState =
  | { state: 'ready' }
  | { state: 'missing' }
  | { state: 'preparing', phase: 'fetch' | 'unpack', got: number, total: number }
  | { state: 'error', error: string }

interface Job { id: string, done: boolean, error: string, phase: 'fetch' | 'unpack', sizes: { got: number, total: number }[] }

export interface ServerFilesDeps {
  modelsDir: string
  models?: CatalogModel[]
  sets?: Record<string, FetchEntry[]>
  fetch?: typeof globalThis.fetch
  retryMs?: number
  log?: (msg: string) => void
}

export function createServerFiles(deps: ServerFilesDeps) {
  const models = deps.models ?? (CATALOG.models as CatalogModel[])
  const sets = deps.sets ?? (SETS as Record<string, FetchEntry[]>)
  const jobs = new Map<string, Job>()
  // One fetch at a time, whatever the model: a Pi's link and disk stay usable.
  let queue: Promise<unknown> = Promise.resolve()

  const isFile = (f: string, bytes?: number) => stat(f).then(s => s.isFile() && (bytes == null || s.size === bytes), () => false)

  // Is this entry in place? A model archive is when the files the phone
  // downloads are, at their catalog sizes (cheap: no sha256 of 600 MB on every
  // Install); another archive when its stamp is.
  async function has(m: CatalogModel, e: FetchEntry): Promise<boolean> {
    if (e.to) return isFile(path.join(deps.modelsDir, e.to))
    if (e.dir === m.dir) {
      const all = await Promise.all(m.files.map(f => isFile(path.join(deps.modelsDir, m.dir, f.path), f.bytes)))
      return all.every(Boolean)
    }
    const stamp = await readFile(path.join(deps.modelsDir, e.dir!, '.complete'), 'utf8').catch(() => '')
    return stamp.trim() === e.sha256
  }

  const entriesOf = (m: CatalogModel) => [...(sets.runtime ?? []), ...(sets[m.set] ?? [])]

  async function missingOf(m: CatalogModel) {
    const out: FetchEntry[] = []
    for (const e of entriesOf(m)) if (!(await has(m, e))) out.push(e)
    return out
  }

  async function work(m: CatalogModel, job: Job) {
    // Checked again here: a fetch queued before this one may have brought the runtime.
    const todo = await missingOf(m)
    // An archive's size is close to its model's files; a single file's is known once it starts.
    job.sizes = todo.map(e => ({ got: 0, total: e.to ? 0 : m.files.reduce((n, f) => n + f.bytes, 0) }))
    for (const [i, e] of todo.entries()) {
      job.phase = 'fetch'
      const size = job.sizes[i]!
      const opts: FetchOptions = {
        fetchImpl: deps.fetch,
        retryMs: deps.retryMs,
        log: deps.log,
        onBytes: (got, total) => { size.got = got; if (total) size.total = total },
        onUnpack: () => { job.phase = 'unpack' },
      }
      // A stamp left beside a missing file would make the script skip the archive.
      if (e.dir) await rm(path.join(deps.modelsDir, e.dir, '.complete'), { force: true })
      await fetchEntry(deps.modelsDir, e, opts)
      size.got = size.total = Math.max(size.got, size.total)
    }
  }

  function view(job: Job): ServerFilesState {
    if (job.error) return { state: 'error', error: job.error }
    const got = job.sizes.reduce((n, s) => n + s.got, 0)
    const total = job.sizes.reduce((n, s) => n + Math.max(s.got, s.total), 0)
    return { state: 'preparing', phase: job.phase, got, total }
  }

  function start(m: CatalogModel): Job {
    const job: Job = { id: m.id, done: false, error: '', phase: 'fetch', sizes: [] }
    jobs.set(m.id, job)
    const run = queue.then(() => work(m, job))
    queue = run.catch(() => {})
    run.then(
      () => { job.done = true; jobs.delete(m.id) },
      (e: Error) => { job.error = e.message; deps.log?.(`dictation files for ${m.id}: ${e.message}`) },
    )
    return job
  }

  return {
    // Where this model's files stand on the server, starting their fetch when
    // `fetch` is set and they are missing. A failed fetch is told once, then
    // the next request tries again (the parts already downloaded are kept).
    async prepare(id: string, fetch = true): Promise<ServerFilesState> {
      const m = models.find(x => x.id === id)
      if (!m) throw new HerdrError('bad_model', `Unknown model: ${id}`)
      const job = jobs.get(id)
      if (job && !job.done) {
        if (job.error) jobs.delete(id)
        return view(job)
      }
      if (!(await missingOf(m)).length) return { state: 'ready' }
      if (!fetch) return { state: 'missing' }
      // Another request may have started it while the files were checked.
      const again = jobs.get(id)
      return view(again && !again.error ? again : start(m))
    },
  }
}
