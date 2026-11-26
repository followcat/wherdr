import { describe, expect, it, vi } from 'vitest'
import { createShellFs, FsError, READ_CHUNK, READ_LIMIT, type ExecResult, type ShellExec } from '../server/utils/fsx'

const failing: ShellExec = async () => { throw new Error('no exec expected') }
const reply = (stdout: Buffer, extra: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout, stderr: '', ...extra })

describe('the read bounds of a remote file system', () => {
  it('caps a read at the image budget', () => {
    expect(READ_LIMIT).toBe(60 * 1024 * 1024)
    expect(READ_CHUNK).toBe(4 * 1024 * 1024)
  })

  it('refuses a read chunk that is not a safe positive integer', () => {
    for (const readChunk of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => createShellFs(failing, { readChunk }), String(readChunk)).toThrow(/invalid readChunk/)
    }
    expect(() => createShellFs(failing, { readChunk: 1024 })).not.toThrow()
  })

  it('refuses an invalid range before running anything', async () => {
    const fs = createShellFs(failing)
    const bad: [number, number, string][] = [
      [0, -Infinity, 'invalid read length'],
      [0, Number.NaN, 'invalid read range'],
      [0, 1.5, 'invalid read range'],
      [-1, 8, 'invalid read range'],
      [Number.NaN, 8, 'invalid read range'],
      [Number.MAX_SAFE_INTEGER, 8, 'invalid read range'],
      [0, READ_LIMIT + 1, 'read too large'],
    ]
    for (const [start, len, message] of bad) {
      const e = await fs.read('/home/alice/big.jsonl', start, len).catch((x: unknown) => x)
      expect(e, `${start}/${len}`).toBeInstanceOf(FsError)
      expect((e as FsError).code, `${start}/${len}`).toBe('remote')
      expect((e as Error).message, `${start}/${len}`).toBe(message)
    }
    // An empty read is answered without touching the machine.
    expect((await fs.read('/home/alice/big.jsonl', 0, 0)).length).toBe(0)
  })

  it('reads a range longer than one reply in equal slices and in order', async () => {
    const file = Buffer.alloc(9 * 1024 * 1024 + 17)
    for (let i = 0; i < file.length; i++) file[i] = i % 251
    const asked: [number, number][] = []
    const exec: ShellExec = async (_script, args) => {
      const from = Number(args![1]) - 1
      const count = Number(args![2])
      asked.push([from, count])
      return reply(file.subarray(from, from + count))
    }
    const got = await createShellFs(exec).read('/home/alice/big.jsonl', 0, file.length)
    expect(got.equals(file)).toBe(true)
    expect(asked).toEqual([[0, READ_CHUNK], [READ_CHUNK, READ_CHUNK], [2 * READ_CHUNK, 1024 * 1024 + 17]])
  })

  it('stops at the end of the file, keeping what it got', async () => {
    const file = Buffer.from('0123456789')
    const asked: number[] = []
    const exec: ShellExec = async (_script, args) => {
      const from = Number(args![1]) - 1
      const count = Number(args![2])
      asked.push(count)
      return reply(file.subarray(from, from + count))
    }
    expect((await createShellFs(exec).read('/home/alice/notes.txt', 0, 20)).toString()).toBe('0123456789')
    expect(asked).toEqual([20])
    // An empty reply is the end of the file, not an error.
    expect((await createShellFs(async () => reply(Buffer.alloc(0))).read('/home/alice/notes.txt', 40, 10)).length).toBe(0)
  })

  it('bounds every reply of a multi-chunk read by one deadline, never one per chunk', async () => {
    const budget: (number | undefined)[] = []
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const exec: ShellExec = async (_script, _args, opts) => {
        budget.push(opts?.timeoutMs)
        now += 40_000 // every chunk takes 40 s
        return reply(Buffer.alloc(4, 0x61))
      }
      const e = await createShellFs(exec, { readChunk: 4 }).read('/home/alice/line.jsonl', 0, 40, 60_000).catch((x: unknown) => x)
      expect((e as FsError).code).toBe('unreachable')
      expect((e as Error).message).toBe('read timed out')
      // 60 s for the whole read: 60 s then 20 s left, the third chunk none.
      expect(budget).toEqual([60_000, 20_000])
    } finally { clock.mockRestore() }
  })

  it('refuses a reply that serves more than the chunk it asked for', async () => {
    const exec: ShellExec = async () => reply(Buffer.alloc(5, 0x61))
    const e = await createShellFs(exec, { readChunk: 4 }).read('/home/alice/line.jsonl', 0, 4).catch((x: unknown) => x)
    expect((e as FsError).code).toBe('remote')
    expect((e as Error).message).toBe('reply exceeds requested chunk')
  })

  it('passes the chunk bound to the machine, and keeps a short reply as the end of the file', async () => {
    const seen: (number | undefined)[] = []
    const exec: ShellExec = async (_script, _args, opts) => {
      seen.push(opts?.maxBytes)
      return reply(Buffer.from('abc'))
    }
    expect((await createShellFs(exec).read('/home/alice/line.jsonl', 0, 99)).toString()).toBe('abc')
    expect(seen).toEqual([99])
  })
})
