import { chmodSync, mkdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localShell } from '../server/utils/agentProcesses'
import { CMD_HEADERS_SCRIPT, parseCmdHeaders } from '../server/utils/commandCodeHeaderRecords'
import type { ShellExec } from '../server/utils/fsx'
import { U1, U2, cleanupHomes, hdr, mkhome, put, putSess, rootOf } from './cmdHeaderFixture'

afterEach(cleanupHomes)

describe('parseCmdHeaders', () => {
  const ROOT = '/home/user/.commandcode/projects'
  const P = (id: string) => `${ROOT}/proj/${id}.jsonl`
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  const R = (p: string, stat = '7 1700000000.123 42 regular file', hb = 'e30=') => `R\x01${b64(p)}\x01${stat}\x01${hb}`
  const E = (p: string, why = 'gone') => `E\x01${b64(p)}\x01${why}`
  const inputs = [P(U1), P(U2)]

  it('parses ordered records and per-record errors', () => {
    const r = parseCmdHeaders(inputs, `H\n${R(P(U1))}\n${E(P(U2))}\nT 1 1 0\n`)
    expect(r.bad).toBeUndefined()
    expect(r.records[0]).toMatchObject({ raw: Buffer.from('{}'), st: { ino: 42, size: 7 } })
    expect(r.records[1]).toEqual({ error: 'gone' })
  })

  it('rejects framing, order, count and path mismatches', () => {
    expect(parseCmdHeaders(inputs, `T 1 1 0\n${R(P(U1))}\n`).bad).toBe('truncated')
    expect(parseCmdHeaders(inputs, `H\n${R(P(U2))}\n${R(P(U1))}\nT 2 0 0\n`).bad).toBe('truncated') // wrong order
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1))}\nT 1 0 0\n`).bad).toBe('truncated') // short, no overflow flag
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1))}\n${R(P(U2))}\n${R(P(U1))}\nT 2 0 0\n`).bad).toBe('truncated') // extra record
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1))}\n${E(P(U2))}\nT 1 0 0\n`).bad).toBe('truncated') // e count wrong
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1))}\n${E(P(U2))}\nT 1 1 8\n`).bad).toBe('truncated') // unknown flag
    expect(parseCmdHeaders(inputs, `H\nR\x01${b64('/etc/x')}\x017 1700000000 42 regular file\x01e30K\nT 1 0 0\n`).bad).toBe('truncated') // path not input[0]
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1), 'garbage')}\nT 1 0 0\n`).bad).toBe('truncated')
    expect(parseCmdHeaders(inputs, `H\n${E(P(U1), 'WHY')}\nT 0 1 0\n`).bad).toBe('truncated') // non-word reason
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1))}\n${E(P(U2))}\nT 1 1 ${'9'.repeat(400)}\n`).bad).toBe('truncated') // unsafe counter
  })

  it('accepts an overflowed stream and reports oversize', () => {
    const r = parseCmdHeaders(inputs, `H\n${R(P(U1))}\nT 1 0 4\n`)
    expect(r.bad).toBe('oversize')
    expect(r.records[0]).toMatchObject({ raw: Buffer.from('{}') })
    expect(r.records[1]).toBeNull()
  })

  it('maps every known footer flag to incomplete, even over valid records', () => {
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1))}\n${E(P(U2))}\nT 1 1 1\n`).bad).toBe('metadata')
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1))}\n${R(P(U2))}\nT 2 0 1\n`).bad).toBe('metadata') // flag with all-good records
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1))}\n${R(P(U2))}\nT 2 0 2\n`).bad).toBe('raced')
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1))}\n${R(P(U2))}\nT 2 0 4\n`).bad).toBe('oversize')
  })

  it('requires R and E counts separately, not just their sum', () => {
    // Single input keeps emitted===inputs so only the count split can fire.
    expect(parseCmdHeaders([P(U1)], `H\n${R(P(U1))}\nT 0 1 0\n`).bad).toBe('truncated') // r=0 claimed, an R emitted
    expect(parseCmdHeaders([P(U1)], `H\n${E(P(U1))}\nT 1 0 0\n`).bad).toBe('truncated') // e=0 claimed, an E emitted
  })

  it('bounds inputs and the raw payload before allocating', () => {
    const many = Array.from({ length: 9000 }, (_, i) => `${ROOT}/d${i}/${U1}.jsonl`)
    const r = parseCmdHeaders(many, 'H\nT 0 0 0\n')
    expect(r.bad).toBe('oversize') // cap rejected before any 9000-entry allocation
    expect(r.records).toEqual([])
    // An oversized header payload is rejected before decoding the field.
    const giant = Buffer.alloc(20000, 0x78).toString('base64')
    expect(parseCmdHeaders(inputs, `H\n${R(P(U1), '7 1700000000 42 regular file', giant)}\nT 1 0 0\n`).bad).toBe('truncated')
    // An absurd input path cannot reach the request loop at all.
    const huge = [`${ROOT}/${'x'.repeat(9000)}/${U1}.jsonl`]
    expect(parseCmdHeaders(huge, 'H\nT 0 0 0\n').bad).toBe('truncated')
  })
})

// Producer-level checks run CMD_HEADERS_SCRIPT itself through localShell and
// parse the raw wire — no dependency on the later cache module.
const runScript = async (exec: ShellExec, root: string, files: string[]) => {
  const r = await exec(CMD_HEADERS_SCRIPT, [root, ...files], { timeoutMs: 5000 })
  expect(r.code).toBe(0)
  return parseCmdHeaders(files, r.stdout.toString('utf8'))
}

describe('CMD_HEADERS_SCRIPT', () => {
  it('reads a bounded prefix for every path, however large the file', async () => {
    const home = mkhome()
    const f1 = putSess(home, 'p', U1)
    const f2 = putSess(home, 'q', U2, '/work/two', 'x'.repeat(3 * 1024 * 1024)) // multi-MB body
    const p = await runScript(localShell, rootOf(home), [f1, f2])
    expect(p.bad).toBeUndefined()
    expect(p.records.every(r => r !== null && 'raw' in r)).toBe(true)
    for (const r of p.records) {
      expect((r as { raw: Buffer }).raw.length).toBeLessThanOrEqual(16385)
      expect((r as { raw: Buffer }).raw.indexOf(0x0a)).toBeGreaterThan(0) // full first line inside
    }
  })

  it('keeps a complete 16384-byte header line and its newline', async () => {
    const home = mkhome()
    // head -c 16385 over-reads by one: a complete 16 KiB line + '\n' arrives
    // whole, while a longer line arrives as exactly 16385 bytes with no nl.
    const base = JSON.stringify({ type: 'session', version: 3, id: U1, cwd: '' }).length
    const cwd = '/' + 'x'.repeat(16384 - base - 1)
    const f = put(home, 'p', `${U1}.jsonl`, JSON.stringify({ type: 'session', version: 3, id: U1, cwd }) + '\nbody\n')
    const p = await runScript(localShell, rootOf(home), [f])
    const rec = p.records[0] as { raw: Buffer }
    expect(rec.raw.length).toBe(16385)
    expect(rec.raw[16384]).toBe(0x0a) // the newline survived
    const over = put(home, 'q', `${U2}.jsonl`, `{"type":"session","version":3,"id":"${U2}","cwd":"/${'x'.repeat(20000)}"}\n`)
    const p2 = await runScript(localShell, rootOf(home), [over])
    const raw2 = (p2.records[0] as { raw: Buffer }).raw
    expect(raw2.length).toBe(16385)
    expect(raw2.indexOf(0x0a)).toBe(-1) // overlong: no newline inside the prefix
  })

  it('round-trips newline, unicode and metachar dir names through the wire', async () => {
    const home = mkhome()
    const files = ['a b', 'uni-λ', 'with\nnewline', 'a$HOME`x`'].map(d => putSess(home, d, U1))
    const p = await runScript(localShell, rootOf(home), files)
    expect(p.bad).toBeUndefined()
    expect(p.records.every(r => r !== null && 'raw' in r && r.raw.length > 0)).toBe(true)
  })

  it('refuses symlinked root, project dir and file shapes before any open', async () => {
    const home = mkhome()
    const root = rootOf(home)
    // Project dir renamed and replaced by a symlink: stat still works through
    // it, but the record must be an error, never a followed read.
    const kept = join(root, 'kept')
    mkdirSync(kept, { recursive: true })
    writeFileSync(join(kept, `${U1}.jsonl`), hdr(U1) + 'x\n')
    symlinkSync(kept, join(root, 'p'))
    const p1 = await runScript(localShell, root, [join(root, 'p', `${U1}.jsonl`)])
    expect(p1.records[0]).toEqual({ error: 'dirlink' })
    expect(p1.bad).toBe('metadata')
    // Same trick on the root itself.
    const home2 = mkhome()
    const realRoot = join(home2, 'realprojects')
    mkdirSync(join(realRoot, 'p'), { recursive: true })
    writeFileSync(join(realRoot, 'p', `${U1}.jsonl`), hdr(U1) + 'x\n')
    mkdirSync(join(home2, '.commandcode'), { recursive: true })
    symlinkSync(realRoot, rootOf(home2))
    const p2 = await runScript(localShell, rootOf(home2), [join(rootOf(home2), 'p', `${U1}.jsonl`)])
    expect(p2.records[0]).toEqual({ error: 'rootlink' })
    expect(p2.bad).toBe('metadata')
    // And a symlink where the transcript file itself should be.
    const real = putSess(home2, 'p', U1)
    const link = join(realRoot, 'p', `${U2}.jsonl`)
    symlinkSync(real, link)
    const p3 = await runScript(localShell, realRoot, [link])
    expect(p3.records[0]).toEqual({ error: 'symlink' })
    expect(p3.bad).toBe('metadata')
  })

  it('reports a vanished file and a mid-read stat flip as raced', async () => {
    const home = mkhome()
    const gone = putSess(home, 'p', U1)
    unlinkSync(gone)
    const p1 = await runScript(localShell, rootOf(home), [gone])
    expect(p1.records[0]).toEqual({ error: 'gone' })
    expect(p1.bad).toBe('raced')
    // Second stat of the file reports a different inode -> sa != sb.
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const f = putSess(home, 'q', U2)
    writeFileSync(join(bin, 'stat'), `#!/bin/sh
c=${join(home, 'count')}
n=0; [ -f "$c" ] && n=$(cat "$c")
case "$3" in
  *${U2}*) n=$((n+1)); echo $n > "$c"; [ $n -gt 1 ] && { echo "7 1700000000 999999 regular file"; exit 0; } ;;
esac
exec /usr/bin/stat "$@"
`)
    chmodSync(join(bin, 'stat'), 0o755)
    const exec: ShellExec = (s, a, o) => localShell(`PATH=${bin}:$PATH\n` + s, a, o)
    const p2 = await runScript(exec, rootOf(home), [f])
    expect(p2.records[0]).toEqual({ error: 'changed' })
    expect(p2.bad).toBe('raced')
    expect(statSync(f).isFile()).toBe(true)
  })

  it('rechecks a root swapped for a symlink mid-batch per path', async () => {
    const home = mkhome()
    const fa = putSess(home, 'a', U1) // 'a' sorts first: A reads, then the swap
    const fb = putSess(home, 'b', U2)
    const root = rootOf(home)
    const kept = `${root}.kept`
    const bin = join(home, 'bin')
    mkdirSync(bin)
    // First head invocation serves file A normally, then atomically renames
    // root -> kept and symlinks root -> kept. File B then arrives through a
    // symlinked root with inode/mtime still equal — it must not be read.
    writeFileSync(join(bin, 'head'), `#!/bin/sh
m=${join(home, 'mark')}
if [ ! -f "$m" ]; then
  /usr/bin/head "$@"; rc=$?
  touch "$m"
  mv "${root}" "${kept}" && ln -s "${kept}" "${root}"
  exit $rc
fi
exec /usr/bin/head "$@"
`)
    chmodSync(join(bin, 'head'), 0o755)
    const exec: ShellExec = (s, a, o) => localShell(`PATH=${bin}:$PATH\n` + s, a, o)
    const p = await runScript(exec, root, [fa, fb])
    expect(p.records[0]).toMatchObject({ st: expect.anything() }) // A read fine
    expect(p.records[1]).toEqual({ error: 'rootlink' }) // B refused through the link
    expect(p.bad).toBe('metadata')
  })
})
