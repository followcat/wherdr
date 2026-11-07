// OpenCode pane -> session selection: the fail-closed rule of
// server/utils/opencodeCore.ts over injected scan/catalog evidence.
// One candidate selects; none, a hidden peer, a same-cwd peer, an
// ambiguous top and a session older than the process all refuse.
import { expect, it } from 'vitest'
import { createOpencodeCore, type OcTerminalDetail } from '../server/utils/opencodeCore'
import type { OpencodeScan, OpencodeProc } from '../server/utils/opencodeProcs'
import type { OpencodeReadCatalog, OpencodeCatalogRow } from '../server/utils/opencodeReadCatalog'
import type { ShellExec } from '../server/utils/fsx'

const exec = (() => Promise.reject(new Error('no exec in tests'))) as unknown as ShellExec
const row = (id: string, directory: string, created: number, updated: number): OpencodeCatalogRow =>
  ({ id, parent: null, fork: null, title: null, directory, subpath: null, created, updated, viewed: null, idle: null, archived: null })
const proc = (pid: number, cwd: string, startedAt: number, ticks = 1000): OpencodeProc =>
  ({ pid, cwd, argv: ['/x/opencode'], startedAt, startTicks: ticks })
const scanOf = (rows: OpencodeProc[], uncertain: OpencodeProc[] = []): OpencodeScan =>
  ({ complete: true, rows, uncertain, scanned: 10, emitted: rows.length + uncertain.length })
const catalogOf = (rows: OpencodeCatalogRow[], server = 'a'.repeat(32)): OpencodeReadCatalog =>
  ({ ok: true, server, fingerprint: 'b'.repeat(64), directory: '/proj', pages: 1, size: 100, rows, exhausted: true, consistency: 'unproven' })

// The pane's root is the opencode process itself (recorded launch argv).
const detail = (over: Partial<OcTerminalDetail> = {}): OcTerminalDetail => ({
  state: 'live', pid: 100, argv: ['/x/opencode'], created_ms: 5000,
  foreground: { pid: 100, name: 'opencode', argv: ['/x/opencode'], cwd: '/proj' },
  ...over,
})
// A scan where pid 100 is the only opencode in /proj, born at t=5s.
const target = () => proc(100, '/proj', 5000, 900)

it('one qualifying candidate selects its session and server', async () => {
  const core = createOpencodeCore(exec, '/home/user', {
    scan: async () => scanOf([target()]),
    catalog: async () => catalogOf([row('ses_1', '/proj', 1000, 6000), row('ses_2', '/other', 1000, 9000)]),
  })
  expect(await core.locate(detail())).toEqual({ session: 'ses_1', server: 'a'.repeat(32) })
})

it('no candidate in the process cwd stays unavailable', async () => {
  const core = createOpencodeCore(exec, '/home/user', {
    scan: async () => scanOf([target()]),
    catalog: async () => catalogOf([row('ses_1', '/elsewhere', 1000, 9000)]),
  })
  expect(await core.locate(detail())).toEqual({ unavailable: 'session' })
})

it('two live opencode processes in the same cwd refuse', async () => {
  const core = createOpencodeCore(exec, '/home/user', {
    scan: async () => scanOf([target(), proc(200, '/proj', 4000, 800)]),
    catalog: async () => catalogOf([row('ses_1', '/proj', 1000, 9000)]),
  })
  expect(await core.locate(detail())).toEqual({ unavailable: 'peers' })
})

it('a session updated before the process start is not claimed', async () => {
  const core = createOpencodeCore(exec, '/home/user', {
    scan: async () => scanOf([target()]),
    catalog: async () => catalogOf([row('ses_1', '/proj', 1000, 4000)]),
  })
  expect(await core.locate(detail())).toEqual({ unavailable: 'session' })
})

it('the most recently updated qualifying session wins; a tie is ambiguous', async () => {
  const win = createOpencodeCore(exec, '/home/user', {
    scan: async () => scanOf([target()]),
    catalog: async () => catalogOf([row('ses_1', '/proj', 1000, 6000), row('ses_2', '/proj', 2000, 9000)]),
  })
  expect(await win.locate(detail())).toEqual({ session: 'ses_2', server: 'a'.repeat(32) })
  const tie = createOpencodeCore(exec, '/home/user', {
    scan: async () => scanOf([target()]),
    catalog: async () => catalogOf([row('ses_1', '/proj', 1000, 9000), row('ses_2', '/proj', 2000, 9000)]),
  })
  expect(await tie.locate(detail())).toEqual({ unavailable: 'ambiguous' })
})

it('an unreadable peer cwd or an incomplete scan refuses before the catalog', async () => {
  let catalogs = 0
  const core = createOpencodeCore(exec, '/home/user', {
    scan: async () => scanOf([target()], [proc(300, '', 1000, 700)]),
    catalog: async () => { catalogs++; return catalogOf([row('ses_1', '/proj', 1000, 9000)]) },
  })
  expect(await core.locate(detail())).toEqual({ unavailable: 'peers' })
  expect(catalogs).toBe(0)
  const bad = createOpencodeCore(exec, '/home/user', {
    scan: async () => ({ complete: false, rows: [], uncertain: [], scanned: 0, emitted: 0 }),
    catalog: async () => catalogOf([]),
  })
  expect(await bad.locate(detail())).toEqual({ unavailable: 'scan' })
})

it('a non-root target needs its generation observed before it resolves', async () => {
  let now = 10000
  const core = createOpencodeCore(exec, '/home/user', {
    now: () => now,
    scan: async () => scanOf([proc(100, '/bin/sh', 0, 1), proc(250, '/proj', 6000, 800)]),
    catalog: async () => catalogOf([row('ses_1', '/proj', 1000, 7000)]),
  })
  // The pane's root is a shell; the foreground is the opencode process.
  const d = detail({ argv: ['/bin/sh'], created_ms: 4000,
    foreground: { pid: 250, name: 'opencode', argv: ['/x/opencode'], cwd: '/proj' } })
  // First observation arms the bound at this wall — a session updated
  // before it cannot prove it is this process's.
  expect(await core.locate(d)).toEqual({ unavailable: 'session' })
  now += 1000
  expect(await core.locate(d)).toEqual({ unavailable: 'session' })
  // A session updated after the first observation qualifies on a locator
  // whose own first observation is earlier than the update.
  const core2 = createOpencodeCore(exec, '/home/user', {
    now: () => 20000,
    scan: async () => scanOf([proc(100, '/bin/sh', 0, 1), proc(250, '/proj', 6000, 800)]),
    catalog: async () => catalogOf([row('ses_1', '/proj', 1000, 30000)]),
  })
  expect(await core2.locate(d)).toEqual({ session: 'ses_1', server: 'a'.repeat(32) })
})

it('a terminal that is not showing opencode reports no target', async () => {
  const core = createOpencodeCore(exec, '/home/user', {
    scan: async () => scanOf([]),
    catalog: async () => catalogOf([]),
  })
  expect(await core.locate(detail({ argv: ['/bin/sh'], foreground: { pid: 42, name: 'vim', argv: ['vim'], cwd: '/proj' } }))).toEqual({ unavailable: 'target' })
  expect(await core.locate({ state: 'exited', pid: 100, argv: ['/x/opencode'] })).toEqual({ unavailable: 'detail' })
})
