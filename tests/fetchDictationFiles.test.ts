// scripts/dictation-files.mjs (the fetch script's code): pinned files, checked before use,
// resumed after a cut.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETS, download, fetchEntry, setsOf } from '../scripts/dictation-files.mjs'

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
  it('keeps a file already in place without downloading it again', async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, 'm.wasm'), body)
    const s = server(body)
    await fetchEntry(dir, { url: 'https://x/m.wasm', sha256: sha, to: 'm.wasm' }, { fetchImpl: s.fetchImpl })
    expect(s.calls).toEqual([])
  })
})
