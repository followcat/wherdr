import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localShell } from '../server/utils/agentProcesses'
import { CMD_FILES_SCRIPT, cmdFiles } from '../server/utils/commandCodeFiles'
import { cmdProjectsRoot } from '../server/utils/commandCodeSessions'
import type { ShellExec } from '../server/utils/fsx'

const U1 = '01234567-89ab-cdef-0123-456789abcdef'
const U2 = '11111111-2222-4333-8444-555555555555'
const U3 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const roots: string[] = []
const mkhome = () => {
  const h = mkdtempSync(join(tmpdir(), 'cmdfiles-'))
  roots.push(h)
  return h
}
const rootOf = (home: string) => cmdProjectsRoot(home)
const put = (home: string, dir: string, name: string, body = '{}') => {
  const d = join(rootOf(home), dir)
  mkdirSync(d, { recursive: true })
  const f = join(d, name)
  writeFileSync(f, body)
  return f
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const names = (files: { file: string }[]) => files.map(f => f.file).sort()

describe('commandCodeFiles producer', () => {
  it('reports a complete empty snapshot when the root is missing or empty', async () => {
    const home = mkhome()
    let s = await cmdFiles(localShell, home)
    expect(s).toMatchObject({ complete: true, files: [], dirs: 0, found: 0 })
    mkdirSync(rootOf(home), { recursive: true })
    s = await cmdFiles(localShell, home)
    expect(s).toMatchObject({ complete: true, files: [], dirs: 0, found: 0 })
  })

  it('rejects a root that is a file, a symlink or unreadable', async () => {
    const home = mkhome()
    mkdirSync(join(home, '.commandcode'), { recursive: true })
    writeFileSync(rootOf(home), 'x')
    expect((await cmdFiles(localShell, home)).incomplete).toBe('metadata')
    rmSync(rootOf(home))
    symlinkSync(home, rootOf(home))
    expect((await cmdFiles(localShell, home)).incomplete).toBe('metadata')
    rmSync(rootOf(home), { recursive: true })
    mkdirSync(rootOf(home), { mode: 0 })
    expect((await cmdFiles(localShell, home)).incomplete).toBe('metadata')
    chmodSync(rootOf(home), 0o755)
  })

  it('rejects a non-canonical root without running the script', async () => {
    const home = mkhome()
    let ran = false
    const exec: ShellExec = async (s, a, o) => { ran = true; return localShell(s, a, o) }
    const s = await cmdFiles(exec, home, { root: 'rel/dir/../x' })
    expect(s.incomplete).toBe('metadata')
    expect(ran).toBe(false)
  })

  it('lists uuid.jsonl files across project dirs with full stat metadata', async () => {
    const home = mkhome()
    const f1 = put(home, 'proj-a', `${U1}.jsonl`, '{"type":"session"}')
    const f2 = put(home, 'proj-b', `${U2}.jsonl`, 'x'.repeat(100))
    const s = await cmdFiles(localShell, home)
    expect(s.complete).toBe(true)
    expect(s.dirs).toBe(2)
    expect(s.found).toBe(2)
    expect(names(s.files)).toEqual([f1, f2].sort())
    const byFile = new Map(s.files.map(f => [f.file, f]))
    expect(byFile.get(f2)!.size).toBe(100)
    expect(byFile.get(f1)!.ino).toBe(statSync(f1).ino)
    expect(Math.abs(byFile.get(f1)!.mtimeMs - statSync(f1).mtimeMs)).toBeLessThan(1)
  })

  it('ignores sidecars, wrong depths, non-uuid names and posing directories', async () => {
    const home = mkhome()
    const good = put(home, 'proj', `${U1}.jsonl`)
    put(home, 'proj', `${U1}.checkpoints.jsonl`)
    put(home, 'proj', `${U1}.meta.json`)
    put(home, 'proj', 'not-a-uuid.jsonl')
    put(home, 'proj/sub', `${U2}.jsonl`) // depth 3: never enumerated
    writeFileSync(join(rootOf(home), `${U3}.jsonl`), 'x') // depth 1: not inside a project dir
    mkdirSync(join(rootOf(home), 'proj', `${U3}.jsonl`)) // directory posing as a file
    const s = await cmdFiles(localShell, home)
    expect(s.complete).toBe(true)
    expect(s.files).toEqual([expect.objectContaining({ file: good })])
    expect(s.found).toBe(3) // uuid + checkpoints + not-a-uuid are *.jsonl; seen, not candidates
  })

  it('round-trips newline, space, unicode and metachar project dir names', async () => {
    const home = mkhome()
    for (const dir of ['a b', 'uni-λ', 'with\nnewline', 'a$HOME`x`']) {
      put(home, dir, `${U1}.jsonl`)
    }
    const s = await cmdFiles(localShell, home)
    expect(s.complete).toBe(true)
    expect(s.dirs).toBe(4)
    expect(names(s.files)).toEqual([
      join(rootOf(home), 'a b', `${U1}.jsonl`),
      join(rootOf(home), 'uni-λ', `${U1}.jsonl`),
      join(rootOf(home), 'with\nnewline', `${U1}.jsonl`),
      join(rootOf(home), 'a$HOME`x`', `${U1}.jsonl`)
    ].sort())
  })

  it('is incomplete on symlink files/dirs, never follows them', async () => {
    const home = mkhome()
    const real = put(home, 'proj', `${U1}.jsonl`)
    symlinkSync(real, join(rootOf(home), 'proj', `${U2}.jsonl`))
    const outside = mkhome() // another synthetic home, stands in for an outside tree
    put(outside, 'sneaky', `${U3}.jsonl`)
    symlinkSync(join(rootOf(outside), 'sneaky'), join(rootOf(home), 'linked-dir'))
    const s = await cmdFiles(localShell, home)
    // Skipping them could pick an older regular session: excluded relevant
    // evidence makes the snapshot incomplete. Nothing is followed or read.
    expect(s.complete).toBe(false)
    expect(s.incomplete).toBe('metadata')
    expect(names(s.files)).toEqual([real])
  })

  it('is incomplete on a dangling root symlink, never a usable empty', async () => {
    const home = mkhome()
    mkdirSync(join(home, '.commandcode'), { recursive: true })
    symlinkSync(join(home, 'nowhere'), rootOf(home)) // target does not exist
    const s = await cmdFiles(localShell, home)
    expect(s.complete).toBe(false)
    expect(s.incomplete).toBe('metadata')
    expect(s.files).toEqual([])
  })

  it('is incomplete on an unreadable candidate even when stat succeeds', async () => {
    const home = mkhome()
    const locked = put(home, 'proj', `${U1}.jsonl`)
    put(home, 'proj', `${U2}.jsonl`)
    chmodSync(locked, 0) // stat still works; the file just can't be read
    const s = await cmdFiles(localShell, home)
    expect(s.complete).toBe(false)
    expect(s.incomplete).toBe('metadata')
    expect(names(s.files)).toEqual([join(rootOf(home), 'proj', `${U2}.jsonl`)])
    chmodSync(locked, 0o644)
  })

  it('marks a glob-listed file or dir that vanishes before its test as raced', async () => {
    const home = mkhome()
    put(home, 'p', `${U1}.jsonl`) // '0…' sorts first in the p dir
    put(home, 'p', `${U2}.jsonl`)
    put(home, 'q', `${U3}.jsonl`) // 'q' sorts after 'p'
    const bin = join(home, 'bin')
    mkdirSync(bin)
    // While stat'ing U1, delete U2's file and the whole q dir: both were
    // glob-listed already and must surface as raced, not be silently absent.
    writeFileSync(join(bin, 'stat'), `#!/bin/sh
case "$3" in
  *${U1}*) rm -f "${rootOf(home)}/p/${U2}.jsonl"; rm -rf "${rootOf(home)}/q" ;;
esac
exec /usr/bin/stat "$@"
`)
    chmodSync(join(bin, 'stat'), 0o755)
    const exec: ShellExec = (s, a, o) => localShell(`PATH=${bin}:$PATH\n` + s, a, o)
    const s = await cmdFiles(exec, home)
    expect(s.complete).toBe(false)
    expect(s.incomplete).toBe('raced')
  })

  it('is incomplete when a project dir is unreadable', async () => {
    const home = mkhome()
    put(home, 'proj', `${U1}.jsonl`)
    put(home, 'locked', `${U2}.jsonl`)
    chmodSync(join(rootOf(home), 'locked'), 0)
    const s = await cmdFiles(localShell, home)
    expect(s.complete).toBe(false)
    expect(s.incomplete).toBe('metadata')
    expect(names(s.files)).toEqual([join(rootOf(home), 'proj', `${U1}.jsonl`)])
    chmodSync(join(rootOf(home), 'locked'), 0o755)
  })

  it('reports a stat failure on a present file as incomplete metadata', async () => {
    const home = mkhome()
    put(home, 'proj', `${U1}.jsonl`)
    put(home, 'proj', `${U2}.jsonl`)
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'stat'), `#!/bin/sh
case "$3" in
  *${U1}*) exit 1 ;;
esac
exec /usr/bin/stat "$@"
`)
    chmodSync(join(bin, 'stat'), 0o755)
    const exec: ShellExec = (s, a, o) => localShell(`PATH=${bin}:$PATH\n` + s, a, o)
    const s = await cmdFiles(exec, home)
    expect(s.complete).toBe(false)
    expect(s.incomplete).toBe('metadata')
    // The failed file is not emitted, but the usable rows still arrive.
    expect(names(s.files)).toEqual([join(rootOf(home), 'proj', `${U2}.jsonl`)])
  })

  it('reports a listed file that vanishes before stat as raced', async () => {
    const home = mkhome()
    put(home, 'proj', `${U1}.jsonl`)
    put(home, 'proj', `${U2}.jsonl`)
    const bin = join(home, 'bin')
    mkdirSync(bin)
    // The shim deletes the file then fails: the re-check sees it gone → raced.
    writeFileSync(join(bin, 'stat'), `#!/bin/sh
case "$3" in
  *${U2}*) rm -f "$3"; exit 1 ;;
esac
exec /usr/bin/stat "$@"
`)
    chmodSync(join(bin, 'stat'), 0o755)
    const exec: ShellExec = (s, a, o) => localShell(`PATH=${bin}:$PATH\n` + s, a, o)
    const s = await cmdFiles(exec, home)
    expect(s.complete).toBe(false)
    expect(s.incomplete).toBe('raced')
    expect(readdirSync(join(rootOf(home), 'proj'))).not.toContain(`${U2}.jsonl`)
  })

  it('is incomplete when the file cap is exhausted, never a truncated list', async () => {
    const home = mkhome()
    put(home, 'p', `${U1}.jsonl`)
    put(home, 'p', `${U2}.jsonl`)
    put(home, 'q', `${U3}.jsonl`)
    const s = await cmdFiles(localShell, home, { maxFiles: 2 })
    expect(s.complete).toBe(false)
    expect(s.incomplete).toBe('oversize')
  })

  it('reports unavailable when the exec itself fails', async () => {
    const home = mkhome()
    const exec: ShellExec = async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'boom' })
    expect((await cmdFiles(exec, home)).incomplete).toBe('unavailable')
  })

  it('passes the root positionally and matches localShell results (remote parity)', async () => {
    const home = mkhome()
    put(home, 'proj', `${U1}.jsonl`)
    let seen: string[] = []
    const exec: ShellExec = async (s, a, o) => { seen = a || []; return localShell(s, a, o) }
    const [a, b] = await Promise.all([cmdFiles(exec, home), cmdFiles(localShell, home)])
    expect(seen[0]).toBe(rootOf(home))
    expect(names(a.files)).toEqual(names(b.files))
    expect(a.complete).toBe(b.complete)
    expect(CMD_FILES_SCRIPT).not.toContain(rootOf(home)) // never interpolated into code
  })
})

describe('glob literals and counted caps', () => {
  it('scans project dirs literally named like the glob patterns', async () => {
    const home = mkhome()
    // These names expand to strings identical to the unmatched-literal
    // patterns: equality alone must not skip a dir that actually exists.
    // '.!x' is the control — it never equals a literal and always scanned.
    for (const dir of ['*', '.[!.]*', '.!x']) put(home, dir, `${U1}.jsonl`)
    const s = await cmdFiles(localShell, home)
    expect(s.complete).toBe(true)
    expect(s.dirs).toBe(3)
    expect(names(s.files)).toEqual([
      join(rootOf(home), '*', `${U1}.jsonl`),
      join(rootOf(home), '.[!.]*', `${U1}.jsonl`),
      join(rootOf(home), '.!x', `${U1}.jsonl`)
    ].sort())
  })

  it('accepts project dirs whose names start with ..', async () => {
    const home = mkhome()
    // '..x'/'..?*' are ordinary names, not traversal: rel starts with the
    // two characters '..' but the segment is not '..'.
    for (const dir of ['..x', '..?*']) put(home, dir, `${U1}.jsonl`)
    const s = await cmdFiles(localShell, home)
    expect(s.complete).toBe(true)
    expect(s.dirs).toBe(2)
    expect(names(s.files)).toEqual([
      join(rootOf(home), '..x', `${U1}.jsonl`),
      join(rootOf(home), '..?*', `${U1}.jsonl`)
    ].sort())
  })

  it('counts a file literally named *.jsonl instead of skipping it as a literal', async () => {
    const home = mkhome()
    const good = put(home, 'proj', `${U1}.jsonl`)
    put(home, 'proj', '*.jsonl') // real file whose path equals the literal pattern
    const s = await cmdFiles(localShell, home)
    expect(s.complete).toBe(true)
    expect(s.found).toBe(2) // counted as found, skipped as a non-uuid sidecar
    expect(names(s.files)).toEqual([good])
  })

  it('applies the dir and file caps to flagged entries, not only scanned ones', async () => {
    const home = mkhome()
    // Two symlink dirs + one real dir, maxDirs=2: flagged entries spend from
    // the same budget — p and q are counted (dirs=3 when r trips the cap)
    // instead of slipping past uncounted (dirs=1, unbounded scan). Bit 1
    // dominates the reason, so it reports metadata either way.
    const target = mkhome()
    put(target, 'x', `${U1}.jsonl`)
    mkdirSync(rootOf(home), { recursive: true })
    for (const d of ['p', 'q']) symlinkSync(join(rootOf(target), 'x'), join(rootOf(home), d))
    put(home, 'r', `${U2}.jsonl`)
    let s = await cmdFiles(localShell, home, { maxDirs: 2 })
    expect(s.incomplete).toBe('metadata')
    expect(s.dirs).toBe(3)
    // Same for files: the third symlink spends the last of maxf — found=3
    // (each counted, capped, early exit) instead of found=1.
    const home2 = mkhome()
    const real = put(home2, 'ext', `${U3}.jsonl`)
    mkdirSync(join(rootOf(home2), 'proj'), { recursive: true })
    for (const id of [U1, U2, '22222222-3333-4444-8555-666666666666']) {
      symlinkSync(real, join(rootOf(home2), 'proj', `${id}.jsonl`))
    }
    s = await cmdFiles(localShell, home2, { maxFiles: 2 })
    expect(s.incomplete).toBe('metadata')
    expect(s.found).toBe(3)
  })
})
