// On-device dictation files: the pinned sets (WASM runtimes, models from the
// catalogs app/utils/dictation/models.json and app/utils/speech/voices.json)
// and their checked, resumable
// download into DATA_DIR/models. Used by scripts/fetch-dictation-files.mjs and
// bundled into the server (server/utils/dictationServerFiles.ts), so this
// module has no CLI: importing it never starts a download. Every file is
// pinned (exact URL) and checked against its sha256 before it is moved into
// place; files already in place are kept, an interrupted download resumes.
// Model and voice sets come from the catalogs (`set`, `source`, `dir`, and
// `files` or `members`): a model or a voice is added there, not here. Based on followcat's scripts/fetch-asr-models.sh (MIT).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, constants, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import bunzip2 from 'unbzip2-stream'
import CATALOG from '../app/utils/dictation/models.json' with { type: 'json' }
import VOICES from '../app/utils/speech/voices.json' with { type: 'json' }

// sherpa-onnx's combined WASM build with followcat's ASR bindings (his
// branch mobile, commit 679ff70; no official release ships this build).
const SHERPA = 'https://raw.githubusercontent.com/followcat/wherdr/679ff70f98d0a296477776a7d3fb2344a0c8a1d5/public/wasm/'
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/'
// sherpa-onnx's TTS binding for that build: the same file from v1.12.34 to
// v1.12.40, the releases whose ASR config the build above matches.
const SHERPA_TTS = 'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/21473b6bd2f3ed317426b05f27bab09fd160d0a0/wasm/tts/sherpa-onnx-tts.js'

// A file: { url, sha256, to } with `to` relative to DATA_DIR/models.
// An archive: { url, sha256, dir, members }, its members extracted into `dir`.
export const SETS = {
  runtime: [
    ['sherpa-onnx-wasm-combined.js', 'c7778951c5ef025d240ecf36d8d642ee2aa089353d4e46187767044547313e57'],
    ['sherpa-onnx-wasm-combined.wasm', 'cc726f48a62ceba05541c195b7155482da7232d9300405fb5a4a7ddce6110705'],
    ['sherpa-onnx-core.js', '7913d88d173bc2140d52085cc9d62bf3c8a9b95e53842704329007fa0e37b879'],
    ['sherpa-onnx-asr.js', 'a83eb0f88258864453e3c910fb1954f8f78c2cca071ebac06329fcfa25c8b88d'],
  ].map(([name, sha256]) => ({ url: SHERPA + name, sha256, to: `runtime/sherpa-onnx-679ff70/${name}` })).concat(
    { url: SHERPA_TTS, sha256: 'c330199603f74785db93d3b272afee15a3572c7a222b382361298d4e58716c13', to: 'runtime/sherpa-onnx-679ff70/sherpa-onnx-tts.js' },
  ),
  ort: [
    ['ort.webgpu.min.js', 'c94f5bb9c17bd37168e9b4220facb2b6fc1dd125a5e91b7a680171840a27f254'],
    ['ort.wasm.min.js', 'c6bc9f8e1d0ecc3983a57910e6a30b2230a512bcd2e0207cd64306459c3de7b4'],
    ['ort-wasm-simd-threaded.wasm', '45eaee27761ad883742a8d4b8fce1538d60ce43b51adf1726fafccc59b8c1a15'],
    ['ort-wasm-simd-threaded.jsep.mjs', 'c7b70c8003f077c62849e15275d0b1f1d1cf1a6dfc63b967400567c7224bfdbe'],
    ['ort-wasm-simd-threaded.jsep.wasm', 'ac0d8f1cfbf2732420ad78a86072b8507253c63885a61c3fd640b3055256d31d'],
    ['ort-wasm-simd-threaded.asyncify.mjs', '249b4dc791f081d33bd11760bfd669fe85f97289e679bbeb291b874272125dff'],
    ['ort-wasm-simd-threaded.asyncify.wasm', 'babec0bbddb6d3082623b99b7e1391b75e0729bcca076ff8424d7753af97fada'],
  ].map(([name, sha256]) => ({ url: ORT + name, sha256, to: `runtime/onnxruntime-web-1.23.2/${name}` })),
}
export { CATALOG, VOICES }
for (const m of CATALOG.models) {
  SETS[m.set] = [{ url: m.source.url, sha256: m.source.sha256, dir: m.dir, members: m.files.map(f => f.path) }]
}
// A voice comes from an archive (its members extracted), or as loose files
// under `source.base`, each with its own sha256 (no archive is published).
for (const v of VOICES.voices) {
  SETS[v.set] = v.source.url
    ? [{ url: v.source.url, sha256: v.source.sha256, dir: v.dir, members: v.members.map(f => f.path) }]
    : v.members.map(f => ({ url: v.source.base + f.path, sha256: f.sha256, to: `${v.dir}/${f.path}` }))
}
export const DEFAULT_SETS = ['runtime', CATALOG.models[0].set]

export async function sha256Of(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

const exists = file => stat(file).then(s => s.isFile(), () => false)

// url → file, through file.part: resumed with Range when a part is left, then
// moved into place only when its sha256 matches. `onBytes(got, total)` follows
// the transfer (total 0 when unknown); `fetchImpl` and `retryMs` for the tests.
export async function download(url, sha256, file, { fetchImpl = fetch, tries = 5, retryMs = 1000, log = () => {}, onBytes } = {}) {
  const part = `${file}.part`
  await mkdir(path.dirname(file), { recursive: true })
  let reached = 0
  for (let attempt = 1; ; attempt++) {
    try {
      const have = await stat(part).then(s => s.size, () => 0)
      const res = await fetchImpl(url, { headers: have ? { range: `bytes=${have}-` } : {}, redirect: 'follow' })
      if (res.status === 416 && have) {
        // The part is already whole (or longer than the file): check it below.
        await res.body?.cancel()
      } else if (res.ok && res.body) {
        const append = have > 0 && res.status === 206
        let got = append ? have : 0
        const size = Number(res.headers.get('content-length')) || 0
        const total = size ? got + size : 0
        const count = new Transform({ transform(chunk, _enc, done) { got += chunk.length; reached = got; onBytes?.(got, total); done(null, chunk) } })
        await pipeline(Readable.fromWeb(res.body), count, createWriteStream(part, { flags: append ? 'a' : 'w' }))
      } else {
        await res.body?.cancel()
        throw new Error(`HTTP ${res.status}`)
      }
      const got = await sha256Of(part)
      if (got !== sha256) {
        await rm(part, { force: true })
        throw new Error(`the downloaded file is not the pinned one (sha256 mismatch: expected ${sha256}, got ${got})`)
      }
      await rename(part, file)
      return
    } catch (err) {
      if (attempt >= tries) {
        // Said in plain words: how far a cut download got (its part is kept to resume).
        const why = /^HTTP |sha256 mismatch/.test(err.message) ? err.message : reached ? `the download was cut at ${mb(reached)}: ${err.message}` : `the download failed: ${err.message}`
        throw new Error(`${why} (${url})`)
      }
      log(`retry ${attempt}: ${err.message}`)
      await new Promise(r => setTimeout(r, Math.min(30_000, retryMs * 2 ** attempt)))
    }
  }
}

const mb = n => `${Math.round(n / 1e6)} MB`

// The archive formats tar unpacks: its flag and the program GNU tar runs for it.
const FORMATS = [
  { ext: '.tar.bz2', flags: ['-j'], program: 'bzip2' },
  { ext: '.tbz2', flags: ['-j'], program: 'bzip2' },
  { ext: '.tar.gz', flags: ['-z'], program: 'gzip' },
  { ext: '.tgz', flags: ['-z'], program: 'gzip' },
  { ext: '.tar.xz', flags: ['-J'], program: 'xz' },
  { ext: '.tar.zst', flags: ['--zstd'], program: 'zstd' },
  { ext: '.tar', flags: [], program: '' },
]

// The tar command that extracts `members` of an archive (all under its top
// folder, named as the archive) straight into `dir`. With `stdin`, tar reads
// the decompressed tar from its input (the JS bzip2 decoder) instead.
export function extractCommand(archive, dir, members, { stdin = false } = {}) {
  const name = path.basename(archive)
  const format = FORMATS.find(f => name.endsWith(f.ext))
  if (!format) throw new Error(`unknown archive format: ${name}`)
  const top = name.slice(0, -format.ext.length)
  const source = stdin ? ['-f', '-'] : [...format.flags, '-f', archive]
  const args = ['-x', ...source, '-C', dir, '--strip-components=1', ...members.map(m => `${top}/${m}`)]
  return { args, program: format.program }
}

// tar's error output in plain words; `program` is the archive's decompressor.
export function tarFailure(stderr, code, program) {
  const missing = [...stderr.matchAll(/([^\s:]+): Not found in archive/g)].map(m => m[1].split('/').pop())
  if (/Cannot exec|Can't initialize filter|unrecognized option|Unsupported compression|not supported/i.test(stderr)) {
    return needs(program || 'a newer tar')
  }
  if (/No space left on device/i.test(stderr)) return 'the server ran out of disk space while unpacking the model'
  if (/Permission denied|Read-only file system/i.test(stderr)) return 'the server cannot write to its models folder (permission denied)'
  if (/Unexpected EOF|ends unexpectedly|truncated|ended prematurely|unexpected end of file/i.test(stderr)) return 'the archive is incomplete: it ends before its last file'
  if (missing.length) return `the archive lacks the files ${missing.join(', ')}`
  const decoder = /^bzip2 decoder: (.*)$/m.exec(stderr)
  if (decoder) return `the archive could not be decoded: ${decoder[1]}`
  const last = stderr.trim().split('\n').filter(l => !/not recoverable|Child returned/.test(l)).pop()
  return `tar exited with ${code}${last ? `: ${last}` : ''}`
}

const APT = { xz: 'xz-utils' }

// The message for a decompressor the server lacks, with the command that installs it.
function needs(program) {
  const install = !/^[a-z0-9]+$/.test(program) ? ''
    : process.platform === 'darwin' ? ` (brew install ${program})` : ` (sudo apt install ${APT[program] || program})`
  return `this archive format needs ${program} on the server: install it${install}, then try again`
}

async function onPath(program) {
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    if (await access(path.join(d, program), constants.X_OK).then(() => true, () => false)) return true
  }
  return false
}

// How this server unpacks the format, checked before a download of hundreds
// of MB: 'tar' when tar decompresses it (bsdtar has the decompressors built
// in, GNU tar runs `program` from the PATH), 'js' for bzip2 without the
// program (decoded in JS and streamed into tar, so bzip2 is never a
// requirement), null when it cannot.
export async function unpackMode(program, { has = onPath } = {}) {
  if (!program) return 'tar'
  const version = await runTar(['--version']).then(r => r.out, () => '')
  if (/bsdtar/.test(version) || await has(program)) return 'tar'
  return program === 'bzip2' ? 'js' : null
}

// Runs tar; `input`, when given, is piped into its stdin (an error there
// ends tar and is reported in its stderr).
function runTar(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += b })
    child.stderr.on('data', (b) => { err += b })
    child.on('error', e => reject(new Error(e.code === 'ENOENT' ? 'the server has no tar command' : e.message)))
    child.on('close', code => resolve({ code, out, err }))
    if (input) {
      child.stdin.on('error', () => {})
      input.on('error', (e) => {
        err += `bzip2 decoder: ${e.message}\n`
        child.kill()
      })
      input.pipe(child.stdin)
    }
  })
}

// Extracts the archive's members into `dir` (`mode` from unpackMode). On
// failure, the archive and the members it left half written are removed and
// the error says why.
export async function unpack(archive, dir, members, { mode = 'tar' } = {}) {
  const js = mode === 'js'
  const { args, program } = extractCommand(archive, dir, members, { stdin: js })
  const { code, err } = await runTar(args, js ? createReadStream(archive).pipe(bunzip2()) : undefined)
  if (code === 0) return
  await Promise.all([archive, ...members.map(m => path.join(dir, m))].map(f => rm(f, { force: true })))
  throw new Error(tarFailure(err, code, program))
}

// One entry of a set, skipped when already in place. `onUnpack` is called
// before an archive is extracted.
export async function fetchEntry(modelsDir, entry, opts = {}) {
  const log = opts.log || (() => {})
  if (entry.to) {
    const file = path.join(modelsDir, entry.to)
    if (await exists(file) && await sha256Of(file) === entry.sha256) return log(`have ${entry.to}`)
    log(`fetch ${entry.url}`)
    return download(entry.url, entry.sha256, file, opts)
  }
  // An archive: its checked sha256 is written to .complete once extracted.
  const dir = path.join(modelsDir, entry.dir)
  const stamp = path.join(dir, '.complete')
  if ((await readFile(stamp, 'utf8').catch(() => '')).trim() === entry.sha256) return log(`have ${entry.dir}`)
  const archive = path.join(dir, path.basename(new URL(entry.url).pathname))
  const { program } = extractCommand(archive, dir, entry.members)
  const mode = await unpackMode(program, opts)
  if (!mode) throw new Error(needs(program))
  log(`fetch ${entry.url}`)
  await download(entry.url, entry.sha256, archive, opts)
  opts.onUnpack?.()
  await unpack(archive, dir, entry.members, { mode })
  await rm(archive, { force: true })
  await writeFile(stamp, `${entry.sha256}\n`)
}

export function setsOf(args) {
  const names = !args.length ? DEFAULT_SETS : args.includes('all') ? Object.keys(SETS) : args
  const unknown = names.filter(n => !(n in SETS))
  if (unknown.length) throw new Error(`unknown set: ${unknown.join(', ')} (sets: ${Object.keys(SETS).join(', ')}, all)`)
  return names
}

// Every entry of the named sets into modelsDir (the script, `wherdr dictation fetch`).
export async function fetchSets(modelsDir, names, opts = {}) {
  const log = opts.log || (() => {})
  log(`into ${modelsDir}`)
  for (const name of names) {
    for (const entry of SETS[name]) await fetchEntry(modelsDir, entry, { ...opts, log })
  }
}
