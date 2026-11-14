// A video of the agent's machine streamed to the browser's <video>: whole
// (200) or one byte range (206), at any size, never held in memory.
//
// One shell process per request opens the file once (fd 3) and keeps that
// descriptor for everything: identity and size from its metadata, its first
// bytes (signature), then the bytes served. dd seeks to the range (skip= on a
// regular file is an lseek, BusyBox included) and reads nothing before it.
// The bytes flow straight to the response; when the browser drops the
// request, the process is killed (locally its whole group, remotely the SSH
// session, whose dd then dies on a closed pipe).
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import { HerdrError } from './herdr'
import type { Machine } from './machines'
import type { ChatFilesPolicy } from '../../shared/chatFiles'
import { OPEN_FILE, VIDEO_HEAD, cleanRelative, isVideo, rootOf, shellError, writtenTarget } from './files'

// dd's block: the range is read from the block holding its first byte.
export const VIDEO_BLOCK = 64 * 1024
const OPEN_TIMEOUT_MS = 15000

// "<now> <inode> <size> <mtime> <version>\n" (the machine's clock first)
// and the first VIDEO_HEAD bytes (one read), then "<skip> <count>" awaited on
// stdin: `count` blocks from block `skip` after those first bytes.
export const STREAM_SCRIPT = `${OPEN_FILE}
m=$(meta) || exit 4
echo "$(date +%s) $m"
dd bs=${VIDEO_HEAD} count=1 <&3 2>/dev/null
read skip count || exit 0
[ "$count" -gt 0 ] 2>/dev/null || exit 0
exec dd bs=${VIDEO_BLOCK} skip="$skip" count="$count" <&3 2>/dev/null`

export type RangeAnswer = { kind: 'full' } | { kind: 'none' } | { kind: 'part', start: number, end: number }

// A Range header against a file of `size` bytes (RFC 9110 §14.1.1): no header,
// another unit or an invalid one: the whole file. Valid but no satisfiable
// range: 'none' (416). Otherwise the first satisfiable range, alone.
export function parseRange(header: string | undefined, size: number): RangeAnswer {
  if (header === undefined) return { kind: 'full' }
  const m = /^bytes[ \t]*=[ \t]*(.*)$/i.exec(header.trim())
  if (!m) return { kind: 'full' }
  const specs = m[1]!.split(',').map(x => x.trim()).filter(Boolean)
  if (!specs.length) return { kind: 'full' }
  const parsed: { first?: number, last?: number, suffix?: number }[] = []
  for (const spec of specs) {
    const r = /^(\d*)-(\d*)$/.exec(spec)
    if (!r || (!r[1] && !r[2])) return { kind: 'full' }
    // Number() of a huge digit string is a huge number or Infinity: only ever compared.
    if (!r[1]) parsed.push({ suffix: Number(r[2]) })
    else {
      const first = Number(r[1])
      const last = r[2] ? Number(r[2]) : undefined
      if (last !== undefined && last < first) return { kind: 'full' }
      parsed.push({ first, last })
    }
  }
  for (const p of parsed) {
    if (p.suffix !== undefined) {
      if (p.suffix > 0 && size > 0) return { kind: 'part', start: Math.max(0, size - p.suffix), end: size - 1 }
    } else if (p.first! < size) {
      return { kind: 'part', start: p.first!, end: Math.min(p.last ?? size - 1, size - 1) }
    }
  }
  return { kind: 'none' }
}

// The answer to a GET or HEAD of a video (`etag`: strong or W/). HEAD ignores
// Range (RFC 9110 §14.2): the whole representation's headers. If-Range keeps
// the Range only for the same strong ETag; a date never matches (one-second
// precision cannot tell two versions apart).
export function answer(v: { size: number, etag: string }, req: { method: string, range?: string, ifRange?: string }) {
  let range = req.method === 'HEAD' ? undefined : req.range
  if (range !== undefined && req.ifRange !== undefined && (req.ifRange.trim() !== v.etag || v.etag.startsWith('W/'))) range = undefined
  const r = parseRange(range, v.size)
  if (r.kind === 'none') return { status: 416, start: 0, len: 0, contentRange: `bytes */${v.size}` }
  if (r.kind === 'full') return { status: 200, start: 0, len: v.size }
  return { status: 206, start: r.start, len: r.end - r.start + 1, contentRange: `bytes ${r.start}-${r.end}/${v.size}` }
}

// The ETag of a version: strong only when its times are precise (below the
// second) and older than 2 s by the machine's clock: a file written within
// the same clock tick keeps its times, so a recent one may still change unseen.
export function videoEtag(meta: { now: number, ino: string, size: number, mtime: number, version: string }) {
  const frac = /\.(\d+)/.exec(meta.version)?.[1] || ''
  const strong = /[1-9]/.test(frac) && meta.now - meta.mtime >= 2
  const hash = crypto.createHash('sha1').update(`${meta.ino}|${meta.size}|${meta.version}`).digest('hex').slice(0, 20)
  return `${strong ? '' : 'W/'}"${hash}"`
}

// A body that fails (the file shrank under it) must not end like a success:
// the connection is cut, so the client sees an incomplete transfer.
export function cutOnError(res: { destroy: () => void }, body: Readable) {
  body.once('error', () => res.destroy())
  return body
}

// What to ask the script for bytes start…start+len-1, the file's first
// `head` bytes being already read (the descriptor stands at `head`): the
// part taken from those bytes, then dd's blocks and the bytes to drop from them.
export function readPlan(start: number, len: number, head: number) {
  const fromHead = start < head ? Math.min(len, head - start) : 0
  const rest = len - fromHead
  if (rest <= 0) return { fromHead, skip: 0, count: 0, drop: 0 }
  const at = start + fromHead - head
  const skip = Math.floor(at / VIDEO_BLOCK)
  const drop = at - skip * VIDEO_BLOCK
  return { fromHead, skip, count: Math.ceil((drop + rest) / VIDEO_BLOCK), drop }
}

export interface OpenedVideo {
  name: string
  size: number
  etag: string
  mtime: number
  // Bytes start…start+len-1, then the process ends; an error if the file shrank.
  read: (start: number, len: number) => Readable
  // Kills the process (any time; nothing left running afterwards).
  close: () => void
  // Settles once the process has exited.
  done: Promise<void>
}

function spawnScript(m: Machine, args: string[]): ChildProcess {
  if (!m.exec) {
    // Its own process group: dd goes with the shell.
    return spawn('sh', ['-c', STREAM_SCRIPT, 'sh', ...args], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  }
  const child = m.spawnShell?.(STREAM_SCRIPT, args)
  if (!child) throw new HerdrError('unreachable', 'Machine unreachable')
  return child
}

function kill(child: ChildProcess, local: boolean) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (local && child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch { /* already gone */ }
}

const closedError = () => new HerdrError('closed', 'Request closed')

// `show`: '1' opens a protected file too (OPEN_FILE's $5).
async function openAt(m: Machine, root: string, rel: string, signal?: AbortSignal, show = ''): Promise<OpenedVideo> {
  if (signal?.aborted) throw closedError()
  const child = spawnScript(m, show ? [root, rel, '', '', show] : [root, rel])
  const done = new Promise<void>((resolve) => { child.on('close', () => resolve()); child.on('error', () => resolve()) })
  const local = !m.exec
  const close = () => kill(child, local)
  child.stdin!.on('error', () => {})
  let buf = Buffer.alloc(0)
  let stderr = ''
  child.stderr!.on('data', (b: Buffer) => { if (stderr.length < 4000) stderr += b.toString('utf8') })
  // First the identity line and the first bytes; nothing more comes before stdin answers.
  const opened = await new Promise<{ now: number, ino: string, size: number, mtime: number, version: string, head: Buffer }>((resolve, reject) => {
    const timer = setTimeout(() => { close(); reject(new HerdrError('timeout', 'The folder took too long to read')) }, OPEN_TIMEOUT_MS)
    // The request closed while opening (slow SSH, root lookup): nothing goes on.
    const onAbort = () => done(() => { close(); reject(closedError()) })
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = (f: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child.stdout!.off('data', onData)
      child.off('close', onClose)
      child.off('error', onError)
      f()
    }
    const onData = (b: Buffer) => {
      buf = Buffer.concat([buf, b])
      const nl = buf.indexOf(10)
      if (nl < 0) return
      const [now = '0', ino = '0', size = '0', mtime = '0', ...version] = buf.subarray(0, nl).toString('utf8').trim().split(/\s+/)
      const n = Number(size) || 0
      const headLen = Math.min(VIDEO_HEAD, n)
      if (buf.length - nl - 1 < headLen) return
      child.stdout!.pause()
      const head = buf.subarray(nl + 1, nl + 1 + headLen)
      done(() => resolve({ now: Number(now) || 0, ino, size: n, mtime: Number(mtime) || 0, version: version.join(' '), head }))
    }
    const onClose = (code: number | null) => done(() => reject(code === 0 ? new HerdrError('not_found', 'File not found') : shellError(m, code, stderr)))
    const onError = () => done(() => reject(new HerdrError('unreachable', 'Machine unreachable')))
    child.stdout!.on('data', onData)
    child.on('close', onClose)
    child.on('error', onError)
  })
  const name = path.posix.basename(rel)
  // A file that is not the video its name says is never served inline.
  if (!isVideo(name, opened.head)) {
    close()
    throw new HerdrError('not_video', 'Not a video')
  }
  let reading = false
  return {
    name,
    size: opened.size,
    mtime: opened.mtime,
    etag: videoEtag(opened),
    close,
    done,
    read(start, len) {
      if (reading) throw new Error('read once')
      reading = true
      const plan = readPlan(start, len, opened.head.length)
      child.stdin!.end(`${plan.skip} ${plan.count}\n`)
      const out = child.stdout!
      async function* bytes() {
        let left = len
        try {
          if (plan.fromHead) {
            yield opened.head.subarray(start, start + plan.fromHead)
            left -= plan.fromHead
          }
          let drop = plan.drop
          for await (const chunk of out as AsyncIterable<Buffer>) {
            if (left <= 0) break
            let c = chunk
            if (drop) {
              const n = Math.min(drop, c.length)
              c = c.subarray(n)
              drop -= n
            }
            if (!c.length) continue
            if (c.length > left) c = c.subarray(0, left)
            left -= c.length
            yield c
            if (left <= 0) break
          }
          // dd met the end of the file before the length announced.
          if (left > 0) throw new HerdrError('truncated', 'The file shrank while being read')
        } finally {
          close()
        }
      }
      return Readable.from(bytes(), { objectMode: false })
    },
  }
}

// Settles with `p`, or rejects as soon as the request closes (`p` itself
// is not stopped: its own signal does that where it can).
function untilClosed<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(closedError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(closedError())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function openVideo(m: Machine, cwd: string, rel: unknown, signal?: AbortSignal) {
  if (signal?.aborted) throw closedError()
  const p = cleanRelative(rel)
  if (!p) throw new HerdrError('not_file', 'Not a file')
  // The Git root lookup: killed with the request locally; over SSH the
  // command finishes on its own (shared executor), but nobody waits for it.
  const root = await untilClosed(rootOf(m, cwd, signal), signal)
  if (signal?.aborted) throw closedError()
  return openAt(m, root, p, signal)
}

export async function openWrittenVideo(m: Machine, cwd: string | null | undefined, written: unknown, signal?: AbortSignal, policy?: ChatFilesPolicy) {
  const t = writtenTarget(m, cwd, written, policy)
  return openAt(m, t.root, t.rel, signal, t.show)
}
