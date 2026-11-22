import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agyConversationFlag, agyFdIds, agyFdsSessions, agySession } from '../server/utils/agySessions'
import { AGY_OTHER, AGY_SESSION } from './helpers/agy-fixture.mjs'
import { type MachineFs, localFs } from '../server/utils/fsx'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-agy-session-'))
  homes.push(home)
  return { home }
}
afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

const cli = (home: string) => path.join(home, '.gemini/antigravity-cli')

it('parses only the exact --conversation argv forms', () => {
  const id = AGY_SESSION
  for (const argv of [['agy', '--conversation', id], ['agy', `--conversation=${id}`], ['/usr/bin/antigravity', '--conversation', id, '--fast']])
    expect(agyConversationFlag(argv)).toBe(id)
  for (const argv of [
    ['agy'],
    ['agy', '--conversation', '../escape'],
    ['agy', '--conversation', 'not-a-uuid'],
    ['agy', '--', '--conversation', id],
    ['agy', 'tell me about --conversation', id],
  ]) expect(agyConversationFlag(argv)).toBeNull()
})

it('recognizes the database, its WAL sidecars and presence locks under the data dir only', () => {
  const { home } = fixture()
  const base = cli(home)
  const paths = [
    `${base}/conversations/${AGY_SESSION}.db`,
    `${base}/conversations/${AGY_SESSION}.db-wal`,
    `${base}/conversations/${AGY_SESSION}.db-shm`,
    `${base}/presence/${AGY_SESSION}.lock`,
    '/var/log/syslog',
    `/other/${AGY_OTHER}.db`,
    `${base}/conversations/not-a-uuid.db`,
  ]
  expect(agyFdsSessions(paths, home, false)).toEqual([AGY_SESSION])
})

it('prefers the open descriptors over the launch argv', async () => {
  const { home } = fixture()
  const fs: MachineFs = { ...localFs, readProcessFiles: async () => [`${cli(home)}/conversations/${AGY_SESSION}.db-wal`, `${cli(home)}/presence/${AGY_SESSION}.lock`] }
  const guess = await agySession(fs, home, { pid: 100, argvExact: true, argv: ['agy', '--conversation', AGY_OTHER] }, false)
  expect(guess).toEqual({ id: AGY_SESSION, ambiguous: false })
})

it('uses the exact argv only when the descriptor scan is unavailable or empty', async () => {
  const { home } = fixture()
  const noScan: MachineFs = { ...localFs, readProcessFiles: async () => null }
  const emptyScan: MachineFs = { ...localFs, readProcessFiles: async () => ['/etc/hosts'] }
  const proc = { pid: 100, argvExact: true, argv: ['agy', '--conversation', AGY_SESSION] }
  for (const fs of [noScan, emptyScan]) expect(await agySession(fs, home, proc, false)).toEqual({ id: AGY_SESSION, ambiguous: false })
  // An inexact argv (ps line, truncated) never resolves a session.
  expect(await agySession(noScan, home, { pid: 100, argvExact: false, argv: proc.argv }, false)).toEqual({ id: null, ambiguous: false })
  expect(await agySession(noScan, home, { argvExact: true, argv: ['agy'] }, false)).toEqual({ id: null, ambiguous: false })
})

it('fails closed when the descriptors point at two conversations', async () => {
  const { home } = fixture()
  const base = cli(home)
  const fs: MachineFs = { ...localFs, readProcessFiles: async () => [`${base}/conversations/${AGY_SESSION}.db`, `${base}/presence/${AGY_OTHER}.lock`] }
  const guess = await agySession(fs, home, { pid: 100, argvExact: true, argv: ['agy', '--conversation', AGY_SESSION] }, false)
  expect(guess).toEqual({ id: null, ambiguous: true })
})

it('honors ANTIGRAVITY_APP_DATA_DIR for local descriptor paths', async () => {
  const { home } = fixture()
  const alternate = path.join(home, 'custom-data')
  vi.stubEnv('ANTIGRAVITY_APP_DATA_DIR', alternate)
  const fs: MachineFs = { ...localFs, readProcessFiles: async () => [`${alternate}/presence/${AGY_SESSION}.lock`, `${cli(home)}/presence/${AGY_OTHER}.lock`] }
  const guess = await agySession(fs, home, { pid: 100 }, true)
  expect(guess).toEqual({ id: AGY_SESSION, ambiguous: false })
})

// A subagent only opens conversations/<subagent-uuid>.db*; the root conversation
// keeps its own presence/<root>.lock and (while active) conversations/<root>.db*.
const SUB_1 = '22222222-3333-4444-8555-666666666666'
const SUB_2 = '33333333-4444-4555-8666-777777777777'

it('resolves the root conversation while subagent databases are open', async () => {
  const { home } = fixture()
  const base = cli(home)
  const fs: MachineFs = {
    ...localFs,
    readProcessFiles: async () => [
      `${base}/presence/${AGY_SESSION}.lock`,
      `${base}/conversations/${AGY_SESSION}.db`,
      `${base}/conversations/${AGY_SESSION}.db-wal`,
      `${base}/conversations/${SUB_1}.db`,
      `${base}/conversations/${SUB_1}.db-wal`,
      `${base}/conversations/${SUB_2}.db-shm`,
    ],
  }
  const guess = await agySession(fs, home, { pid: 100, argvExact: true, argv: ['agy', '--conversation', AGY_OTHER] }, false)
  expect(guess).toEqual({ id: AGY_SESSION, ambiguous: false })
})

it('resolves an idle resumed session that only holds its presence lock', async () => {
  const { home } = fixture()
  const base = cli(home)
  const fs: MachineFs = { ...localFs, readProcessFiles: async () => [`${base}/presence/${AGY_SESSION}.lock`] }
  expect(await agySession(fs, home, { pid: 100 }, false)).toEqual({ id: AGY_SESSION, ambiguous: false })
})

it('fails closed on two presence locks, even with their own databases open', async () => {
  const { home } = fixture()
  const base = cli(home)
  const fs: MachineFs = {
    ...localFs,
    readProcessFiles: async () => [
      `${base}/presence/${AGY_SESSION}.lock`,
      `${base}/conversations/${AGY_SESSION}.db`,
      `${base}/presence/${AGY_OTHER}.lock`,
      `${base}/conversations/${AGY_OTHER}.db`,
    ],
  }
  expect(await agySession(fs, home, { pid: 100 }, false)).toEqual({ id: null, ambiguous: true })
})

it('resolves a lone conversation database when no presence lock is open', async () => {
  const { home } = fixture()
  const base = cli(home)
  const one: MachineFs = { ...localFs, readProcessFiles: async () => [`${base}/conversations/${AGY_SESSION}.db-wal`] }
  expect(await agySession(one, home, { pid: 100 }, false)).toEqual({ id: AGY_SESSION, ambiguous: false })
  const two: MachineFs = {
    ...localFs,
    readProcessFiles: async () => [`${base}/conversations/${AGY_SESSION}.db`, `${base}/conversations/${AGY_OTHER}.db`],
  }
  expect(await agySession(two, home, { pid: 100 }, false)).toEqual({ id: null, ambiguous: true })
})

it('splits presence locks from conversation databases', () => {
  const { home } = fixture()
  const base = cli(home)
  const ids = agyFdIds([
    `${base}/presence/${AGY_SESSION}.lock`,
    `${base}/conversations/${AGY_SESSION}.db-wal`,
    `${base}/conversations/${SUB_1}.db`,
    '/etc/hosts',
  ], home, false)
  expect(ids).toEqual({ presence: [AGY_SESSION], conversations: [AGY_SESSION, SUB_1] })
})
