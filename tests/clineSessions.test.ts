import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { clineDataDir, clineIdFlag, clineLocalBackend, clineSession, type ClineProcess } from '../server/utils/clineSessions'
import { localFs } from '../server/utils/fsx'
import { CLINE_ID, clineMessage, clineText, clineUser, writeClineFixture, writeClineOrphan } from './helpers/cline-fixture.mjs'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-cline-session-'))
  homes.push(home)
  return { home }
}
afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

const birth = Date.parse('2026-01-01T12:00:00Z')
const cwd = '/work/acme-shop'
const user = (text: string) => clineMessage('user', [clineUser(text), clineText('')])
// The pane's foreground is `node …/bin/cline`; its engine `.cline` is a child.
const procs = (extra: string[] = [], engine = 101): ClineProcess[] => [
  { pid: 100, argv: ['node', '/opt/nvm/bin/cline', '-i', ...extra], argvExact: true, startedAt: birth },
  { pid: engine, argv: ['node', '/opt/nvm/lib/node_modules/cline/bin/.cline', '-i', ...extra], argvExact: true, startedAt: birth },
]
const id = (n: number) => `1794894100000_${String(n).padStart(5, '0')}`
const at = (ms: number) => new Date(birth + ms).toISOString()

it('parses only the exact --id form of a resume', () => {
  expect(clineIdFlag(['node', '/opt/bin/cline', '--id', CLINE_ID])).toBe(CLINE_ID)
  expect(clineIdFlag(['node', '/opt/bin/cline', `--id=${CLINE_ID}`])).toBe(CLINE_ID)
  for (const argv of [
    ['node', '/opt/bin/cline'],
    ['node', '/opt/bin/cline', '--id'],
    ['node', '/opt/bin/cline', '--id', '../escape'],
    ['node', '/opt/bin/cline', '--', '--id', CLINE_ID],
    ['node', '/opt/bin/cline', 'tell me about --id', CLINE_ID],
  ]) expect(clineIdFlag(argv)).toBeNull()
})

it('resolves a resumed session named by --id, ahead of a newer one', async () => {
  const { home } = fixture()
  writeClineFixture(home, { id: CLINE_ID, startedAt: at(0), messages: [user('resumed')] })
  writeClineFixture(home, { id: id(2), startedAt: at(60_000), messages: [user('newest')] })
  const guess = await clineSession(localFs, home, procs(['--id', CLINE_ID]), { cwd }, false)
  expect(guess?.id).toBe(CLINE_ID)
  expect(guess?.file).toBe(path.join(home, '.cline/data/sessions', CLINE_ID, `${CLINE_ID}.messages.json`))
  // An id with no manifest names nothing rather than falling back.
  expect(await clineSession(localFs, home, procs(['--id', '1794890000000_absent']), { cwd }, false)).toBeNull()
  // A `--id` reconstructed by ps (inexact argv) never names a session.
  const inexact = procs(['--id', CLINE_ID]).map(p => ({ ...p, argvExact: false }))
  expect(await clineSession(localFs, home, inexact, { cwd: '/work/other' }, false)).toBeNull()
})

it('matches the engine PID with the local backend (--yolo)', async () => {
  const { home } = fixture()
  writeClineFixture(home, { id: id(1), pid: 101, startedAt: at(0), messages: [user('mine')] })
  writeClineFixture(home, { id: id(2), pid: 999, startedAt: at(60_000), messages: [user('another pane')] })
  const guess = await clineSession(localFs, home, procs(['--yolo']), { cwd }, false)
  expect(guess?.id).toBe(id(1))
  // Nothing carries that pid: no conversation rather than the newest of the folder.
  expect(await clineSession(localFs, home, procs(['--yolo'], 555), { cwd }, false)).toBeNull()
})

it('matches the hub backend on the folder and a start at or after the process start', async () => {
  const { home } = fixture()
  // pid is the shared hub daemon, not a pane process.
  writeClineFixture(home, { id: id(1), pid: 3494238, startedAt: at(-60_000), messages: [user('before this pane')] })
  writeClineFixture(home, { id: id(2), pid: 3494238, startedAt: at(1_000), messages: [user('this pane')] })
  writeClineFixture(home, { id: id(3), pid: 3494238, startedAt: at(0), cwd: '/work/other', workspaceRoot: '/work/other' })
  const guess = await clineSession(localFs, home, procs(), { cwd }, false)
  expect(guess?.id).toBe(id(2))
  // The newest session of the folder wins between two candidates.
  writeClineFixture(home, { id: id(4), pid: 3494238, startedAt: at(2_000), messages: [user('newer')] })
  expect((await clineSession(localFs, home, procs(), { cwd }, false))?.id).toBe(id(4))
  // Without a process start, the terminal's own birth still bounds it.
  expect((await clineSession(localFs, home, procs().map(p => ({ ...p, startedAt: undefined })), { cwd, bornAt: birth + 1_500 }, false))?.id).toBe(id(4))
  // No bound at all: the newest of the folder, never nothing.
  expect((await clineSession(localFs, home, procs().map(p => ({ ...p, startedAt: undefined })), { cwd }, false))?.id).toBe(id(4))
})

it('skips a folder without a manifest and never guesses outside the pane folder', async () => {
  const { home } = fixture()
  writeClineOrphan(home)
  expect(await clineSession(localFs, home, procs(), { cwd }, false)).toBeNull()
  writeClineFixture(home, { id: id(1), startedAt: at(1_000), cwd: '/work/elsewhere', workspaceRoot: '/work/elsewhere' })
  expect(await clineSession(localFs, home, procs(), { cwd }, false)).toBeNull()
  // A workspace_root match counts, since the session may run under a subfolder.
  writeClineFixture(home, { id: id(2), startedAt: at(1_000), cwd: '/work/acme-shop/pkg', workspaceRoot: cwd })
  expect((await clineSession(localFs, home, procs(), { cwd }, false))?.id).toBe(id(2))
})

it('reads the store where --data-dir, CLINE_DATA_DIR or CLINE_SESSION_DATA_DIR points', async () => {
  const { home } = fixture()
  const spread = path.join(home, 'work/cline-data')
  writeClineFixture(home, { id: id(1), pid: 101, dataDir: spread, messages: [user('custom dir')] })
  const flags = procs(['--yolo', '--data-dir', spread])
  expect(clineDataDir(home, flags, false)).toBe(spread)
  expect((await clineSession(localFs, home, flags, { cwd }, false))?.id).toBe(id(1))
  // A relative --data-dir is not resolved from an unknown folder: default path.
  expect(clineDataDir(home, procs(['--data-dir', 'relative/dir']), false)).toBe(path.join(home, '.cline/data'))
  // A local run honors the environment overrides; a remote one does not.
  vi.stubEnv('CLINE_DATA_DIR', path.join(home, 'env-data'))
  expect(clineDataDir(home, procs(), true)).toBe(path.join(home, 'env-data'))
  expect(clineDataDir(home, procs(), false)).toBe(path.join(home, '.cline/data'))
  vi.stubEnv('CLINE_DATA_DIR', '')
  vi.stubEnv('CLINE_SESSION_DATA_DIR', path.join(home, 'session-data'))
  expect(clineDataDir(home, procs(), true)).toBe(path.join(home, 'session-data'))
})

it('tells the two backends apart by the launch flags', () => {
  expect(clineLocalBackend(procs(['--yolo']))).toBe(true)
  expect(clineLocalBackend(procs(['--data-dir=/tmp/x']))).toBe(true)
  expect(clineLocalBackend(procs())).toBe(false)
  expect(clineLocalBackend(procs().map(p => ({ ...p, argvExact: false })))).toBe(false)
  // A prompt that mentions the flag is not the flag.
  expect(clineLocalBackend(procs(['Run with --yolo once']))).toBe(false)
})


