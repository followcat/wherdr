// scripts/dictation-files.mjs (the fetch script's code): pinned files, checked before use,
// resumed after a cut.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETS, download, extractCommand, fetchEntry, setsOf, tarFailure, unpack } from '../scripts/dictation-files.mjs'

type Entry = { url: string, sha256: string, to?: string, dir?: string, members?: string[] }
const body = Buffer.from('a'.repeat(1000) + 'b'.repeat(1000))
const sha = createHash('sha256').update(body).digest('hex')
const tmp = () => mkdtempSync(path.join(tmpdir(), 'hw-fetch-'))

// A server that honours Range; `calls` keeps each request's Range header.
function server(data: Buffer) {
  const calls: (string | undefined)[] = []
  const fetchImpl = async (_url: string, init: { headers: Record<string, string> }) => {
    const range = init.headers.range
    calls.push(range)
    const start = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0
    if (start >= data.length) return new Response(null, { status: 416 })
    return new Response(data.subarray(start), { status: range ? 206 : 200 })
  }
  return { calls, fetchImpl }
}

describe('the pinned files', () => {
  it('each has an https URL, a sha256 and a place inside the models folder', () => {
    const places = new Set<string>()
    for (const entry of Object.values(SETS).flat() as Entry[]) {
      expect(entry.url).toMatch(/^https:\/\//)
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      const place = entry.to || entry.dir!
      expect(path.posix.normalize(place)).toBe(place)
      expect(place.startsWith('..') || path.isAbsolute(place)).toBe(false)
      expect(places.has(place)).toBe(false)
      places.add(place)
    }
    // Runtimes are pinned to a version or a commit, and sit under runtime/.
    for (const e of [...SETS.runtime, ...SETS.ort] as Entry[]) expect(e.to).toMatch(/^runtime\/[^/]+-[0-9a-f.]{5,}\//)
  })
  it('has no CLI in the module the server bundles: importing it starts no download', () => {
    const lib = readFileSync(new URL('../scripts/dictation-files.mjs', import.meta.url), 'utf8')
    expect(lib).not.toMatch(/process\.(argv|exit)/)
  })
  it('chooses the default sets, all, or refuses an unknown one', () => {
    expect(setsOf([])).toEqual(['runtime', 'parakeet'])
    expect(setsOf(['all'])).toEqual(Object.keys(SETS))
    expect(() => setsOf(['nope'])).toThrow(/unknown set: nope/)
  })
})

describe('download', () => {
  it('resumes a part left by a cut download', async () => {
    const dir = tmp()
    const file = path.join(dir, 'm.onnx')
    writeFileSync(`${file}.part`, body.subarray(0, 700))
    const s = server(body)
    await download('https://x/m.onnx', sha, file, { fetchImpl: s.fetchImpl })
    expect(s.calls).toEqual(['bytes=700-'])
    expect(readFileSync(file)).toEqual(body)
    expect(existsSync(`${file}.part`)).toBe(false)
  })
  it('never keeps a file whose sha256 differs', async () => {
    const dir = tmp()
    const file = path.join(dir, 'm.onnx')
    const s = server(Buffer.from('tampered'))
    await expect(download('https://x/m.onnx', sha, file, { fetchImpl: s.fetchImpl, tries: 2 }))
      .rejects.toThrow(/sha256 mismatch/)
    expect(s.calls).toHaveLength(2)
    expect(existsSync(file) || existsSync(`${file}.part`)).toBe(false)
  }, 10_000)
  it('says how far a cut download got', async () => {
    const file = path.join(tmp(), 'm.onnx')
    let sent = false
    const cut = new ReadableStream({ async pull(c) { if (sent) { await new Promise(r => setTimeout(r, 20)); return c.error(new Error('terminated')) } sent = true; c.enqueue(new Uint8Array(1_500_000)) } })
    const fetchImpl = async () => new Response(cut, { status: 200 })
    await expect(download('https://x/m.onnx', sha, file, { fetchImpl, tries: 1 }))
      .rejects.toThrow('the download was cut at 2 MB: terminated (https://x/m.onnx)')
  })
  it('keeps a file already in place without downloading it again', async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, 'm.wasm'), body)
    const s = server(body)
    await fetchEntry(dir, { url: 'https://x/m.wasm', sha256: sha, to: 'm.wasm' }, { fetchImpl: s.fetchImpl })
    expect(s.calls).toEqual([])
  })
})

describe('unpack', () => {
  it('builds the tar command of each archive format', () => {
    const flags = (name: string) => extractCommand(`/m/${name}`, '/m', ['a.onnx'])
    expect(flags('pack.tar.bz2')).toEqual({ program: 'bzip2', args: ['-x', '-j', '-f', '/m/pack.tar.bz2', '-C', '/m', '--strip-components=1', 'pack/a.onnx'] })
    expect(flags('pack.tgz')).toMatchObject({ program: 'gzip', args: expect.arrayContaining(['-z', 'pack/a.onnx']) })
    expect(flags('pack.tar.xz')).toMatchObject({ program: 'xz', args: expect.arrayContaining(['-J', 'pack/a.onnx']) })
    expect(flags('pack.tar.zst')).toMatchObject({ program: 'zstd', args: expect.arrayContaining(['--zstd', 'pack/a.onnx']) })
    expect(flags('pack.tar')).toMatchObject({ program: '', args: ['-x', '-f', '/m/pack.tar', '-C', '/m', '--strip-components=1', 'pack/a.onnx'] })
    expect(() => flags('pack.zip')).toThrow(/unknown archive format/)
  })
  it('says in plain words why tar failed', () => {
    const noBzip2 = 'tar (child): bzip2: Cannot exec: No such file or directory\ntar (child): Error is not recoverable: exiting now\ntar: Child returned status 2\n'
    expect(tarFailure(noBzip2, 2, 'bzip2')).toMatch(/^this archive format needs bzip2 on the server: install it \((sudo apt|brew) install bzip2\), then try again$/)
    expect(tarFailure('tar: m/a.onnx: Cannot write: No space left on device\n', 2, 'bzip2')).toMatch(/out of disk space/)
    expect(tarFailure('tar: m/a.onnx: Cannot open: Permission denied\n', 2, 'bzip2')).toMatch(/permission denied/)
    expect(tarFailure('tar: pack/b.onnx: Not found in archive\ntar: Exiting with failure status due to previous errors\n', 2, 'bzip2'))
      .toBe('the archive lacks the files b.onnx')
    expect(tarFailure('tar: odd\n', 1, 'gzip')).toBe('tar exited with 1: tar: odd')
  })
  it('removes a truncated archive and what it half wrote, and says why', async () => {
    const src = tmp()
    mkdirSync(path.join(src, 'pack'))
    writeFileSync(path.join(src, 'pack/a.onnx'), Buffer.alloc(200_000, 7))
    execFileSync('tar', ['-czf', path.join(src, 'pack.tar.gz'), '-C', src, 'pack'])
    const dir = tmp()
    const archive = path.join(dir, 'pack.tar.gz')
    writeFileSync(archive, readFileSync(path.join(src, 'pack.tar.gz')).subarray(0, 300))
    await expect(unpack(archive, dir, ['a.onnx'])).rejects.toThrow('the archive is incomplete: it ends before its last file')
    expect(existsSync(archive) || existsSync(path.join(dir, 'a.onnx'))).toBe(false)
  })
  // A packed voice served by a fake host; the server has no bzip2 (`has`).
  function packedVoice(ext: string, flag: string) {
    const src = tmp()
    mkdirSync(path.join(src, 'voice'))
    writeFileSync(path.join(src, 'voice/model.onnx'), Buffer.alloc(300_000, 3))
    const file = path.join(src, `voice${ext}`)
    execFileSync('tar', [flag, '-cf', file, '-C', src, 'voice'])
    const data = readFileSync(file)
    const entry = { url: `https://example.com/voice${ext}`, sha256: createHash('sha256').update(data).digest('hex'), dir: 'voice', members: ['model.onnx'] }
    return { entry, ...server(data) }
  }
  const noProgram = async () => false
  it('unpacks a .tar.bz2 on a server without bzip2 (JS decoder)', async () => {
    const { entry, fetchImpl } = packedVoice('.tar.bz2', '-j')
    const dir = tmp()
    await fetchEntry(dir, entry, { fetchImpl, has: noProgram, retryMs: 1 })
    expect(readFileSync(path.join(dir, 'voice/model.onnx'))).toEqual(Buffer.alloc(300_000, 3))
  })
  it('refuses an archive it cannot unpack before downloading it, with the command', async () => {
    const { entry, fetchImpl, calls } = packedVoice('.tar.xz', '-J')
    await expect(fetchEntry(tmp(), entry, { fetchImpl, has: noProgram })).rejects.toThrow(/needs xz on the server: install it \((sudo apt install xz-utils|brew install xz)\)/)
    expect(calls).toEqual([])
  })
})
