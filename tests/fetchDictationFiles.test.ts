// scripts/dictation-files.mjs (the fetch script's code): pinned files, checked before use,
// resumed after a cut.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG, SETS, download, extractCommand, fetchEntry, setsOf, tarFailure, unpack } from '../scripts/dictation-files.mjs'

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
    const places = new Map<string, string>()
    // ort is shared: the Canto voices' sets include it, and the named set is
    // the same entries (the fetch skips files already in place). The G2P and
    // OpenCC files are shared by the INT8 and GPU Cantonese voices too; only
    // identical entries may repeat a place.
    for (const entry of Object.entries(SETS).filter(([name]) => name !== 'ort').flatMap(([, entries]) => entries) as Entry[]) {
      expect(entry.url).toMatch(/^https:\/\//)
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      const place = entry.to || entry.dir!
      expect(path.posix.normalize(place)).toBe(place)
      expect(place.startsWith('..') || path.isAbsolute(place)).toBe(false)
      const key = [entry.url, entry.sha256, entry.to, entry.dir, (entry.members || []).join(','), entry.strip].join('|')
      if (places.has(place)) expect(places.get(place)).toBe(key)
      places.set(place, key)
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
  it('builds the qwen3 set of 9 loose pinned files and checks every model runtime set', () => {
    const base = 'https://huggingface.co/jiangzhuo9357/Qwen3-ASR-0.6B-ONNX/resolve/4a01b95fafe2c9e3af77e33c18bbb7de349c62f6/'
    const dir = 'qwen3-asr-0.6b-q4f16-4a01b95'
    const expected: [string, number, string][] = [
      ['prompt_config.json', 2578, '282e0cba43d48f0799c665e2687bea950cbb090bc1def85578d6cdf369c08970'],
      ['mel_filters.json', 132427, 'dcdaf139353616855b4f85e304c075f5f3442573d40637ae0f031db705626181'],
      ['tokenizer.json', 11429377, 'bd2a97b55c8f7f9c328c73ee9b9178771037e9f566dfca8e238a063d41cbac92'],
      ['embed_tokens.int8.bin', 155582464, '9ec07c97a15cb9defb675656edeed0370bc3e7b2c478d1eefe6f948fc6516513'],
      ['embed_scales.f32.bin', 607744, 'acce138a5f06f1233faa4a8a359903b3c303efc0ce37818ad8cf0f9be11fc9b3'],
      ['encoder.fp16.onnx', 376261247, 'af2a517a3d873a401ec9f64a81711e3d780fc8b085fd36f9366f9ac17a54411b'],
      ['decoder_init.q4f16.onnx', 348427, '328a14a46d7284bb6dc5242bc9f6029b013a6f2c42579f9e72dadbaa96ba511d'],
      ['decoder_step.q4f16.onnx', 350380, '27f4588874d1e50a539aed8de424107a8b934a1a5b13368c3a36b467ffcf2024'],
      ['decoder_weights.q4f16.data', 344670208, '898d0c82aad4cae494a4241639c73f9c8e79486fea3b4bac918883397b8f0bcc'],
    ]
    expect(SETS.qwen3).toEqual(expected.map(([name, , sha256]) => ({ url: base + name, sha256, to: `${dir}/${name}` })))
    const qwen = CATALOG.models.find(m => m.set === 'qwen3')!
    expect(qwen.runtime).toBe('ort')
    expect(qwen.files.map(f => [f.path, f.bytes, f.sha256])).toEqual(expected)
    expect(qwen.files.reduce((n, f) => n + f.bytes, 0)).toBe(889_384_852)
    for (const m of CATALOG.models) expect(SETS[m.runtime]).toBeDefined()
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
