import { describe, expect, it } from 'vitest'
import { parseCmdFiles } from '../server/utils/commandCodeFileRecords'

const ROOT = '/home/user/.commandcode/projects'
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const rec = (file: string, stat = '7 1700000000.123456789 42 regular file') => `R\x01${b64(file)}\x01${stat}`
const f = (id: string, dir = 'proj') => `${ROOT}/${dir}/${id}.jsonl`
const U1 = '01234567-89ab-cdef-0123-456789abcdef'
const U2 = '11111111-2222-4333-8444-555555555555'

describe('parseCmdFiles', () => {
  it('parses an empty and a populated snapshot', () => {
    expect(parseCmdFiles(ROOT, 'H\nT 0 0 0 0\n')).toMatchObject({ complete: true, files: [], dirs: 0, found: 0 })
    const s = parseCmdFiles(ROOT, `H\n${rec(f(U1))}\n${rec(f(U2, 'x y\nz'))}\nT 2 2 2 0\n`)
    expect(s.complete).toBe(true)
    expect(s.files.map(x => x.file)).toEqual([f(U1), f(U2, 'x y\nz')])
    expect(s.files[0]).toMatchObject({ ino: 42, size: 7, mtimeMs: 1700000000123.456 })
    expect(s.dirs).toBe(2)
    expect(s.found).toBe(2)
  })

  it('preserves legitimate empty project dirs', () => {
    expect(parseCmdFiles(ROOT, 'H\nT 2 0 0 0\n')).toMatchObject({ complete: true, files: [], dirs: 2, found: 0 })
  })

  it('skips sidecar shapes silently while counting them as found', () => {
    const out = `H\n${rec(f(U1))}\n${rec(f('not-a-uuid'))}\n${rec(`${ROOT}/proj/${U1}.checkpoints.jsonl`)}\nT 1 3 3 0\n`
    const s = parseCmdFiles(ROOT, out)
    expect(s.complete).toBe(true)
    expect(s.files.map(x => x.file)).toEqual([f(U1)])
    expect(s.found).toBe(3)
  })

  it('rejects malformed framing, order, counts and records', () => {
    const good = rec(f(U1))
    expect(parseCmdFiles(ROOT, `T 0 0 0 0\n${good}\n`).incomplete).toBe('truncated') // H not first
    expect(parseCmdFiles(ROOT, `H\n${good}\n`).incomplete).toBe('truncated')       // missing footer
    expect(parseCmdFiles(ROOT, `H\nT 0 0 0 0\n${good}\n`).incomplete).toBe('truncated') // footer not last
    expect(parseCmdFiles(ROOT, `H\n${good}\nT 0 0 0 0\nT 0 0 0 0\n`).incomplete).toBe('truncated')
    expect(parseCmdFiles(ROOT, `H\n${good}\nT 1 1 2 0\n`).incomplete).toBe('truncated') // r != records
    expect(parseCmdFiles(ROOT, `H\n${good}\nT 1 0 1 0\n`).incomplete).toBe('truncated') // f < r
    expect(parseCmdFiles(ROOT, `H\n${good}\nT 0 1 1 0\n`).incomplete).toBe('truncated') // record with 0 dirs
    expect(parseCmdFiles(ROOT, `H\n${good}\nT 1 1 1 16\n`).incomplete).toBe('truncated') // unknown flag bits
    expect(parseCmdFiles(ROOT, `H\n${good}\nT x 1 1 0\n`).incomplete).toBe('truncated')
    expect(parseCmdFiles(ROOT, `H\n${good}\nT ${'9'.repeat(400)} 1 1 0\n`).incomplete).toBe('truncated') // unsafe counter
    expect(parseCmdFiles(ROOT, `H\nX junk\nT 0 1 1 0\n`).incomplete).toBe('truncated')
    expect(parseCmdFiles(ROOT, `H\nR\x01${b64(f(U1))}\nT 1 1 1 0\n`).incomplete).toBe('truncated') // one part
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1), 'garbage')}\nT 1 1 1 0\n`).incomplete).toBe('truncated')
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1), '7 1700000000 x directory')}\nT 1 1 1 0\n`).incomplete).toBe('truncated')
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1), '7 1700000000.1 regular file')}\nT 1 1 1 0\n`).incomplete).toBe('truncated') // no ino
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1), `7 1700000000 ${'9'.repeat(400)} regular file`)}\nT 1 1 1 0\n`).incomplete).toBe('truncated') // unsafe ino
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1), '7 1700000000 0 regular file')}\nT 1 1 1 0\n`).incomplete).toBe('truncated') // ino 0
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1), '-5 1700000000 42 regular file')}\nT 1 1 1 0\n`).incomplete).toBe('truncated') // negative size
  })

  it('rejects impossible counts, wrapped flags and unsafe stat values', () => {
    const good = rec(f(U1))
    // flags=0 means nothing was dropped: a found file with no record is corrupt.
    expect(parseCmdFiles(ROOT, `H\n${good}\nT 1 2 1 0\n`).incomplete).toBe('truncated') // f > r, flags=0
    expect(parseCmdFiles(ROOT, `H\n${good}\nT 1 1 1 4294967296\n`).incomplete).toBe('truncated') // wraps past int32 &
    expect(parseCmdFiles(ROOT, `H\n${good}\nT 2000000 1 1 0\n`).incomplete).toBe('truncated') // safe but absurd counter
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1), '9007199254740993 1700000000 42 regular file')}\nT 1 1 1 0\n`).incomplete).toBe('truncated') // unsafe size
  })

  it('rejects malformed wire paths and duplicate records', () => {
    const good = rec(f(U1))
    // Confined but wrong depth / outside-root / non-canonical paths are not
    // sidecars: the producer never emits them, so they are wire corruption.
    expect(parseCmdFiles(ROOT, `H\n${rec(`${ROOT}/deep/a/b.jsonl`)}\nT 1 1 1 0\n`).incomplete).toBe('truncated')
    expect(parseCmdFiles(ROOT, `H\n${rec(`/etc/${U1}.jsonl`)}\nT 1 1 1 0\n`).incomplete).toBe('truncated')
    expect(parseCmdFiles(ROOT, `H\n${rec(`${ROOT}/proj/../x/${U1}.jsonl`)}\nT 1 1 1 0\n`).incomplete).toBe('truncated')
    expect(parseCmdFiles(ROOT, `H\nR\x01!!!\x017 1700000000 42 regular file\nT 1 1 1 0\n`).incomplete).toBe('truncated')
    expect(parseCmdFiles(ROOT, `H\n${good}\n${good}\nT 1 2 2 0\n`).incomplete).toBe('truncated') // duplicate file
  })

  it('rejects non-canonical base64 and invalid utf-8 path bytes', () => {
    const stat = '7 1700000000 42 regular file'
    // Same bytes without padding: Buffer decodes them identically, so only a
    // decode→re-encode round trip can tell this field is non-canonical.
    const unpadded = b64(f(U1)).replace(/=+$/, '')
    expect(parseCmdFiles(ROOT, `H\nR\x01${unpadded}\x01${stat}\nT 1 1 1 0\n`).incomplete).toBe('truncated')
    // A confined non-uuid basename whose path bytes are not valid UTF-8:
    // decoding replaces the bad byte with U+FFFD, producing a DIFFERENT
    // filename than the producer wrote — it must fail, not sidecar-skip.
    const badBytes = Buffer.concat([Buffer.from(`${ROOT}/proj/`, 'utf8'), Buffer.from([0xff]), Buffer.from('.jsonl', 'utf8')])
    expect(parseCmdFiles(ROOT, `H\nR\x01${badBytes.toString('base64')}\x01${stat}\nT 1 1 1 0\n`).incomplete).toBe('truncated')
    // A real filename containing U+FFFD still round-trips (it was valid UTF-8).
    const uffd = `${ROOT}/we�dir/${U1}.jsonl`
    expect(parseCmdFiles(ROOT, `H\n${rec(uffd)}\nT 1 1 1 0\n`).files.map(x => x.file)).toEqual([uffd])
  })

  it('applies byte-length total, line and record bounds before allocating', () => {
    expect(parseCmdFiles(ROOT, 'x'.repeat(4 * 1024 * 1024 + 1)).incomplete).toBe('oversize')
    expect(parseCmdFiles(ROOT, 'λ'.repeat(2_100_000)).incomplete).toBe('oversize') // 2.1M chars, 4.2M bytes
    expect(parseCmdFiles(ROOT, `H\n${'R'.repeat(70000)}\nT 0 0 0 0\n`).incomplete).toBe('oversize')
    const many = Array.from({ length: 8200 }, (_, i) => rec(f(U1, `d${i}`))).join('\n')
    expect(parseCmdFiles(ROOT, `H\n${many}\nT 1 8200 8200 0\n`).incomplete).toBe('oversize')
  })

  it('maps footer flags to incomplete reasons', () => {
    const tail = (o: number) => `T 1 1 1 ${o}`
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1))}\n${tail(1)}`)).toMatchObject({ complete: false, incomplete: 'metadata' })
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1))}\n${tail(2)}`)).toMatchObject({ complete: false, incomplete: 'raced' })
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1))}\n${tail(4)}`)).toMatchObject({ complete: false, incomplete: 'oversize' })
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1))}\n${tail(8)}`)).toMatchObject({ complete: false, incomplete: 'oversize' })
    // With a nonzero flag, a found-but-dropped row is explained, not corrupt.
    expect(parseCmdFiles(ROOT, `H\n${rec(f(U1))}\nT 1 2 1 1\n`)).toMatchObject({ complete: false, incomplete: 'metadata' })
  })

  it('rejects a non-canonical root before decoding', () => {
    expect(parseCmdFiles(`${ROOT}/../x`, `H\n${rec(f(U1))}\nT 1 1 1 0\n`).incomplete).toBe('metadata')
  })
})
