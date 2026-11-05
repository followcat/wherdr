// Neutral synthetic-home fixtures shared by the Command Code header
// wire/producer and cache/orchestration specs. Every path is a mkdtemp home;
// cleanupHomes() removes them all (call from afterEach).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShellExec } from '../server/utils/fsx'

export const U1 = '01234567-89ab-cdef-0123-456789abcdef'
export const U2 = '11111111-2222-4333-8444-555555555555'
export const U3 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const homes: string[] = []
export const mkhome = () => {
  const h = mkdtempSync(join(tmpdir(), 'cmdhdr-'))
  homes.push(h)
  return h
}
export const cleanupHomes = () => {
  for (const r of homes.splice(0)) rmSync(r, { recursive: true, force: true })
}
export const rootOf = (home: string) => join(home, '.commandcode', 'projects')
export const hdr = (id: string, cwd = '/work/proj', extra = '') => `${JSON.stringify({ type: 'session', version: 3, id, cwd })}${extra}\n`
export const put = (home: string, dir: string, name: string, body: string | Buffer = '') => {
  const d = join(rootOf(home), dir)
  mkdirSync(d, { recursive: true })
  const f = join(d, name)
  writeFileSync(f, body)
  return f
}
export const putSess = (home: string, dir: string, id: string, cwd = '/work/proj', body = 'event') =>
  put(home, dir, `${id}.jsonl`, hdr(id, cwd) + `${body}\n`)

export const counting = (exec: ShellExec) => {
  const seen: string[][] = []
  const calls: ShellExec = async (s, a, o) => { seen.push(a ?? []); return exec(s, a, o) }
  return { exec: calls, seen }
}
