import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { devinResume, devinSession } from '../server/utils/devinSessions'
import { createShellFs, localFs } from '../server/utils/fsx'
import { createTranscripts } from '../server/utils/transcripts'

const homes: string[] = []
const birth = Date.parse('2026-01-01T00:00:00Z')
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'devin-identity-'))
  homes.push(home)
  const root = path.join(home, '.local/share/devin/cli')
  mkdirSync(path.join(root, 'session_locks'), { recursive: true })
  const lock = (id: string, pid: number, at = birth + 1000) => {
    const file = path.join(root, 'session_locks', `${id}.lock`)
    writeFileSync(file, `${pid}\n`)
    utimesSync(file, at / 1000, at / 1000)
  }
  return { home, root, lock }
}
afterEach(() => { vi.restoreAllMocks(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }) })

it('parses explicit local resume arguments without taking prompt text as flags', () => {
  for (const argv of [['devin', '-r', 'session-a'], ['devin', '--resume', 'session-a'], ['devin', '--resume=session-a']]) expect(devinResume(argv)).toBe('session-a')
  for (const argv of [['devin', '-c'], ['devin', '--', '-r', 'session-a'], ['devin', '-r', '../other'], ['devin', '-r', 'https://example.com/x'], ['devin', '-r', '--model']]) expect(devinResume(argv)).toBeNull()
})

it('resolves two processes in the same folder independently by PID', async () => {
  const { home, lock } = fixture()
  lock('session-a', 100)
  lock('session-b', 200)
  expect(await devinSession(localFs, home, { pid: 100, startedAt: birth }, false)).toBe('session-a')
  expect(await devinSession(localFs, home, { pid: 200, startedAt: birth }, false)).toBe('session-b')
  expect(await devinSession(localFs, home, { pid: 300, startedAt: birth }, false)).toBeNull()
})

it('rejects stale PID reuse, oversized locks and unknown process start time', async () => {
  const { home, lock, root } = fixture()
  lock('stale', 100, birth - 10000)
  writeFileSync(path.join(root, 'session_locks/oversized.lock'), '100' + ' '.repeat(40))
  expect(await devinSession(localFs, home, { pid: 100, startedAt: birth }, false)).toBeNull()
  lock('current', 100)
  expect(await devinSession(localFs, home, { pid: 100 }, false)).toBeNull()
  expect(await devinSession(localFs, home, { pid: NaN, argvExact: true, argv: ['devin', '-r', 'current'] }, false)).toBeNull()
})

it('prefers the active lock after resume but refuses two fresh locks for one PID', async () => {
  const { home, lock } = fixture()
  const proc = { pid: 100, startedAt: birth, argvExact: true, argv: ['devin', '-r', 'old'] }
  lock('current', 100)
  expect(await devinSession(localFs, home, proc, false)).toBe('current')
  lock('ambiguous', 100, birth + 2000)
  expect(await devinSession(localFs, home, proc, false)).toBeNull()
})

it('uses explicit resume when locks are absent, and refuses truncated scans', async () => {
  const { home } = fixture()
  const proc = { pid: 100, startedAt: birth, argvExact: true, argv: ['devin', '-r', 'session-a'] }
  expect(await devinSession(localFs, home, proc, false)).toBe('session-a')
  expect(await devinSession({ ...localFs, readdir: async () => Array.from({ length: 4097 }, (_, i) => `${i}.lock`) }, home, proc, false)).toBeNull()
})

it('refreshes identity after in-process resume and stops serving an ambiguous session', async () => {
  const { home, lock, root } = fixture()
  mkdirSync(path.join(root, 'transcripts'))
  for (const id of ['old', 'current']) writeFileSync(path.join(root, 'transcripts', `${id}.json`), JSON.stringify({ schema_version: 'ATIF-v1.7', session_id: id, steps: [{ step_id: 1, source: 'agent', message: id }] }))
  let clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const reader = createTranscripts({ home, herdr: async () => ({ process_info: { foreground_processes: [{ pid: 100, name: 'devin', startedAt: birth, argvExact: true, argv: ['devin', '-r', 'old'] }] } }) })
  const pane = { id: 'p1', agent: 'devin', cwd: '/work/demo' }
  expect((await reader.chat(pane)).session).toBe('old')
  lock('current', 100)
  clock += 1600
  expect((await reader.chat(pane)).session).toBe('current')
  lock('other', 100)
  clock += 1600
  expect(await reader.chat(pane)).toMatchObject({ available: false, reason: 'not_found' })
})

it('rejects locks before or equal to the proven process birth boundary', async () => {
  const { home, lock } = fixture()
  for (const at of [birth - 500, birth]) {
    lock('stale', 100, at)
    expect(await devinSession(localFs, home, { pid: 100, startedAt: birth }, false)).toBeNull()
  }
})

it('does not use resume flags whose argv boundaries were reconstructed by ps', async () => {
  const { home } = fixture()
  expect(await devinSession(localFs, home, { pid: 100, argv: ['devin', 'Explain', '--resume=session-b'], argvExact: false }, false)).toBeNull()
})


it('resolves hundreds of remote locks with a constant number of shell calls', async () => {
  const { home, lock } = fixture()
  for (let i = 0; i < 100; i++) lock(`unrelated-${i}`, 200 + i)
  lock("current ' spaced", 100)
  const exec = vi.fn(async (script: string, args: string[] = []) => await new Promise<any>((resolve) => {
    execFile('sh', ['-c', script, 'sh', ...args], { encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout, stderr: stderr.toString() })
    })
  }))
  const remote = createShellFs(exec, { statTtlMs: 0 })
  for (let i = 0; i < 2; i++) expect(await devinSession(remote, home, { pid: 100, startedAt: birth }, false)).toBe("current ' spaced")
  expect(exec.mock.calls.length).toBeLessThanOrEqual(4)
})
