// Bounded transcript reads over a core wire: createShellFs on coreShell, an
// opt-in chunk size under core's reply ceiling. Every exec argv and every
// returned stdout's decoded size is recorded; no real files, shells or /proc.
import { describe, expect, it, vi } from 'vitest'
import { createShellFs, FsError } from '../server/utils/fsx'
import { coreShell } from '../server/utils/coreTranscripts'

const CHUNK = 4 * 1024 * 1024
// base64 emits exactly 4*ceil(n/3) chars for n bytes — the encoded bound of a
// chunk is equivalent to its decoded bound, and never decodes the payload.
const ENC_CHUNK = Math.ceil(CHUNK / 3) * 4
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64')
const body = (n: number) => {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) % 256
  return b
}

interface Exec { argv: string[], enc: number }
type Reply = { code?: number | null, stdout?: string, stderr?: string, timed_out?: boolean, truncated?: boolean }
// machine.exec: the read script takes [path, tail-skip, head-len]; each reply
// carries its slice base64-encoded, as core really answers. `enc` records the
// reply's encoded length only — bookkeeping never decodes it.
function fakeCall(file: Buffer, answer?: (i: number, part: Buffer) => Partial<Reply>) {
  const execs: Exec[] = []
  const call = async (method: string, params: { argv?: string[] }) => {
    if (method !== 'machine.exec') throw new Error(`unexpected ${method}`)
    const argv = params.argv!
    const i = execs.length
    execs.push({ argv, enc: 0 })
    const args = argv.slice(4)
    const part = file.subarray(Number(args[1]) - 1, Number(args[1]) - 1 + Number(args[2]))
    const r: Reply = { code: 0, stdout: b64(part), stderr: '', ...(answer?.(i, part) || {}) }
    execs[i]!.enc = (r.stdout || '').length
    return r
  }
  return { call, execs }
}
const shellFs = (file: Buffer, answer?: (i: number, part: Buffer) => Partial<Reply>, chunk = CHUNK) => {
  const { call, execs } = fakeCall(file, answer)
  return { fs: createShellFs(coreShell(call, 'box'), { chunkBytes: chunk }), execs }
}

describe('bounded chunked reads over a core wire', () => {
  it('rebuilds a 13 MiB line in <=4 MiB requested and returned chunks', async () => {
    const file = body(13 * 1024 * 1024)
    const { fs, execs } = shellFs(file)
    expect((await fs.read('/s/ses.jsonl', 0, file.length)).equals(file)).toBe(true)
    expect(execs.length).toBe(4)
    for (const e of execs) {
      expect(Number(e.argv[6])).toBeLessThanOrEqual(CHUNK) // slice asked for
      expect(e.enc).toBeLessThanOrEqual(ENC_CHUNK) // slice actually on the wire
    }
    // Contiguous and gapless: each tail starts where the previous head ended.
    expect(execs.map(e => Number(e.argv[5]))).toEqual([1, CHUNK + 1, 2 * CHUNK + 1, 3 * CHUNK + 1])
  })

  it('rebuilds a 24 MiB line — the chat budget — in six chunks', async () => {
    const file = body(24 * 1024 * 1024)
    const { fs, execs } = shellFs(file)
    expect((await fs.read('/s/ses.jsonl', 0, file.length)).equals(file)).toBe(true)
    expect(execs.length).toBe(6)
    expect(execs.every(e => Number(e.argv[6]) <= CHUNK && e.enc <= ENC_CHUNK)).toBe(true)
  })

  it('stops on the genuine short read of file end', async () => {
    const file = body(6 * 1024 * 1024 + 7)
    const { fs, execs } = shellFs(file)
    const got = await fs.read('/s/ses.jsonl', 0, 10 * 1024 * 1024)
    expect(got.equals(file)).toBe(true)
    expect(execs.length).toBe(2) // a full slice, then the short tail: real EOF
  })

  it('never answers a partial read after a later failure', async () => {
    const fails: Partial<Reply>[] = [
      { code: 1, stdout: '', stderr: b64('io error') },
      { timed_out: true, stdout: b64('partial') },
      { truncated: true, stdout: b64(body(2 * 1024 * 1024)) },
    ]
    for (const fail of fails) {
      const { fs } = shellFs(body(13 * 1024 * 1024), i => (i === 2 ? fail : {}))
      await expect(fs.read('/s/ses.jsonl', 0, 13 * 1024 * 1024)).rejects.toBeInstanceOf(FsError)
    }
  })

  it('rejects an over-budget encoded reply before decoding it', async () => {
    const { fs } = shellFs(body(13 * 1024 * 1024), i => (i === 0 ? { stdout: 'A'.repeat(6 * 1024 * 1024) } : {}))
    await expect(fs.read('/s/ses.jsonl', 0, 13 * 1024 * 1024)).rejects.toMatchObject({ code: 'remote' })
  })

  it('spends one wall-time deadline across all chunks', async () => {
    vi.useFakeTimers()
    try {
      const file = body(64 * 1024)
      const { call, execs } = fakeCall(file)
      // Each exec consumes 30 ms of the shared clock, whatever chunk it serves.
      const slow = async (m: string, p: { argv?: string[] }) => {
        vi.advanceTimersByTime(30)
        return call(m, p)
      }
      const fs = createShellFs(coreShell(slow, 'box'), { chunkBytes: 1024 })
      await expect(fs.read('/s/ses.jsonl', 0, file.length, 90)).rejects.toMatchObject({ code: 'unreachable', message: 'read timed out' })
      expect(execs.length).toBe(3) // a 90 ms budget dies on the 4th chunk, not after 64
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects invalid ranges and does no exec for them', async () => {
    const { fs, execs } = shellFs(body(1024))
    expect((await fs.read('/s/ses.jsonl', 0, 0)).length).toBe(0)
    expect((await fs.read('/s/ses.jsonl', 0, -1)).length).toBe(0)
    for (const [s, l] of [[-1, 4], [0.5, 4], [0, 1.5], [0, NaN]]) {
      await expect(fs.read('/s/ses.jsonl', s, l)).rejects.toBeInstanceOf(FsError)
    }
    expect(execs.length).toBe(0)
  })

  it('passes the path positionally, never into the script', async () => {
    const evil = `/x/';$(reboot);#\`id\``
    const { fs, execs } = shellFs(body(64))
    await fs.read(evil, 0, 4)
    expect(execs.length).toBe(1)
    expect(execs[0]!.argv[4]).toBe(evil)
    expect(execs[0]!.argv[2]).not.toContain('reboot')
  })

  it('keeps the default single-exec behavior without the option', async () => {
    const file = body(13 * 1024 * 1024)
    const { call, execs } = fakeCall(file)
    const fs = createShellFs(coreShell(call, 'box'))
    expect((await fs.read('/s/ses.jsonl', 0, file.length)).equals(file)).toBe(true)
    expect(execs.length).toBe(1)
    expect(Number(execs[0]!.argv[6])).toBe(file.length)
  })

  it('bounds a single-chunk read exactly like a slice', async () => {
    // len <= chunkBytes still supplies its per-reply bound: an over-returned
    // or truncated small reply fails instead of being kept.
    for (const fail of [
      { stdout: b64(body(8 * 1024 * 1024)) }, // far beyond the 1 MiB asked
      { truncated: true, stdout: b64(body(512 * 1024)) },
    ]) {
      const { fs } = shellFs(body(1024 * 1024), () => fail)
      await expect(fs.read('/s/ses.jsonl', 0, 1024 * 1024)).rejects.toBeInstanceOf(FsError)
    }
    const { fs, execs } = shellFs(body(1024 * 1024))
    expect((await fs.read('/s/ses.jsonl', 0, 1024 * 1024)).length).toBe(1024 * 1024)
    expect(execs.length).toBe(1)
  })

  it('rejects replies over the supplied bound even when exec ignores it', async () => {
    // A ShellExec that drops maxBytes cannot over-serve a read: run enforces
    // the bound itself on single- and multi-chunk paths alike.
    const rich = async () => ({ code: 0, stdout: Buffer.alloc(5), stderr: '' })
    await expect(createShellFs(rich, { chunkBytes: 4 }).read('/x', 0, 1)).rejects.toMatchObject({ code: 'remote' })
    const fat = async (_s: string, args: string[] = []) => ({ code: 0, stdout: Buffer.alloc(Number(args[2]) + 3), stderr: '' })
    await expect(createShellFs(fat, { chunkBytes: 4 }).read('/x', 0, 10)).rejects.toMatchObject({ code: 'remote' })
  })

  it('rejects failed and over-budget replies before any decode of the payload', async () => {
    const MAL = 'A'.repeat(6 * 1024 * 1024)
    for (const bad of [
      { timed_out: true, stdout: MAL },
      { truncated: true, stdout: MAL },
      { code: 0, stdout: MAL }, // plain over-budget, no flag
    ]) {
      const call = async () => ({ code: 0, stderr: '', ...bad })
      // A decode of the bounded payload is observable, not just absent output.
      const orig = Buffer.from
      const spy = vi.spyOn(Buffer, 'from').mockImplementation(((a: unknown, b?: unknown, c?: unknown) => {
        if (a === MAL) throw new Error('decode of a bounded payload attempted')
        return (orig as (a: unknown, b?: unknown, c?: unknown) => Buffer)(a, b, c)
      }) as never)
      try {
        const r = await coreShell(call, 'box')('true', [], { maxBytes: 1024 })
        expect(r.stdout.length).toBe(0)
        expect(r.code).not.toBe(0)
        expect(spy.mock.calls.some(args => args[0] === MAL)).toBe(false)
      } finally {
        spy.mockRestore()
      }
    }
  })

  it('rejects a chunkBytes option that is not a safe positive integer', async () => {
    const { call } = fakeCall(body(64))
    for (const bad of [Infinity, NaN, 1.5, 0, -4]) {
      expect(() => createShellFs(coreShell(call, 'box'), { chunkBytes: bad })).toThrow()
    }
  })

  it('rejects a read beyond the logical ceiling before allocating', async () => {
    const { fs, execs } = shellFs(body(64))
    // A prohibited allocation is observable: anything over the chunk family
    // of sizes must not come from this read.
    const orig = Buffer.alloc
    const spy = vi.spyOn(Buffer, 'alloc').mockImplementation(((n: number, ...rest: unknown[]) => {
      if (n > 32 * 1024 * 1024) throw new Error('oversized allocation attempted')
      return (orig as (...a: unknown[]) => Buffer)(n, ...rest)
    }) as never)
    try {
      await expect(fs.read('/s/ses.jsonl', 0, 61 * 1024 * 1024)).rejects.toMatchObject({ code: 'remote', message: 'read too large' })
      await expect(fs.read('/s/ses.jsonl', Number.MAX_SAFE_INTEGER - 10, 100)).rejects.toMatchObject({ code: 'remote' })
      expect(execs.length).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})
