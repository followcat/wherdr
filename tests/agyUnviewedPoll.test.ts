import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgyTranscripts } from '../server/utils/agyTranscripts'
import { createModelCtl, createModelRefresh } from '../server/utils/modelctl'
import { createCorePreviews } from '../server/utils/corePreview'
import type { MachineFs } from '../server/utils/fsx'
import type { Pane } from '../shared/types'
import { openAgyFixture } from './helpers/agy-fixture.mjs'

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const fn of cleanups.splice(0)) fn()
})

it('15 unviewed agy panes polled every 1s for 60s read 0 DB bytes and create 0 copies', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'wherdr-unviewed-'))
  const home = mkdtempSync(path.join(scratch, 'home-'))
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }))
  vi.stubEnv('TMPDIR', scratch)

  let bytesRead = 0
  let clock = 1_000
  const store = new Map<string, { buf: Buffer, mtimeMs: number, ino: number }>()
  let ino = 10
  const sync = (p: string) => {
    try {
      store.set(p, { buf: readFileSync(p), mtimeMs: clock, ino: store.get(p)?.ino ?? ++ino })
    } catch { store.delete(p) }
  }
  const fs: MachineFs = {
    async stat(p) {
      const f = store.get(p)
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { size: f.buf.length, mtimeMs: f.mtimeMs, isFile: true, isDir: false, ino: f.ino }
    },
    statMany: ps => Promise.all(ps.map(p => fs.stat(p).catch(() => null))),
    readdir: async () => [],
    readFile: async () => '',
    async read(p, start, len) {
      const f = store.get(p)
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      bytesRead += len
      return Buffer.from(f.buf.subarray(start, start + len))
    },
  }

  const panes: Pane[] = []
  const liveDbs: ReturnType<typeof openAgyFixture>[] = []
  for (let i = 0; i < 15; i++) {
    const sid = `22222222-3333-4444-8555-0000000000${String(i + 1).padStart(2, '0')}`
    const live = openAgyFixture(home, {
      session: sid,
      wal: true,
      model: 'gemini-3-pro',
      modelLabel: 'Gemini 3 Pro',
      rows: [
        { role: 'user', text: `Task ${i + 1}` },
        { role: 'agent', text: `Working response ${i + 1} ${'z'.repeat(20_000)}` },
      ],
    })
    cleanups.push(() => live.close())
    liveDbs.push(live)
    sync(live.file)
    sync(`${live.file}-wal`)
    panes.push({
      id: `p${i + 1}`,
      coreAddress: `host-a/t${i + 1}`,
      machine: 'host-a',
      workspace: 'w1',
      agent: 'agy',
      cwd: '/work/proj',
      agentSession: sid,
      status: i % 2 === 0 ? 'working' : 'idle',
      stateSeq: 1,
    } as Pane)
  }

  const agy = createAgyTranscripts({ home, fs, now: () => clock })
  const viewed = () => false
  const ctl = createModelCtl({
    transcript: (p, opts) => agy.model({ id: p.id, agent: p.agent, cwd: p.cwd, agentSession: p.agentSession }, opts),
    codexConfig: async () => null,
    machineKey: p => p.machine || '',
    now: () => clock,
  })
  const refresh = createModelRefresh({
    currentModel: (p, opts) => ctl.currentModel(p, undefined, opts),
    viewed,
    now: () => clock,
  })
  const previews = createCorePreviews({
    reply: async (p) => {
      const r = await agy.chat({ id: p.id, agent: p.agent, cwd: p.cwd, agentSession: p.agentSession })
      const last = r.items?.findLast(it => it.role === 'assistant')
      return last ? { text: last.text } : null
    },
    read: async () => ' ● Latest screen reply.\n>\n? for shortcuts                                                    auto · Gemini 3 Pro\n',
    viewed,
    now: () => clock,
  })

  for (let s = 0; s < 60; s++) {
    clock += 1_000
    // DB changes every second across active panes, plus periodic status flips.
    const live = liveDbs[s % liveDbs.length]!
    live.append([{ idx: 10 + s, role: 'agent', text: `Tick ${s}` }])
    sync(live.file)
    sync(`${live.file}-wal`)
    if (s % 10 === 0) {
      const flipped = panes[s % panes.length]!
      flipped.status = flipped.status === 'working' ? 'idle' : 'working'
      flipped.stateSeq = (flipped.stateSeq ?? 0) + 1
    }
    for (const p of panes) {
      ctl.noteScreen(p.id, 'agy', ` ● Tick ${s}\n>\n? for shortcuts                                                    auto · Gemini 3 Pro\n`)
      refresh.apply(p)
    }
    previews.apply(panes)
    await new Promise(r => setTimeout(r, 2))
  }

  expect(bytesRead).toBe(0)
  expect(panes[0]?.model?.label).toBe('Gemini 3 Pro')
  expect(panes[0]?.preview).toBe('Latest screen reply.')
})

it('unviewed status flip updates only WAL tail when a kept copy exists and skips DB copies otherwise', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'wherdr-wal-flip-'))
  const home = mkdtempSync(path.join(scratch, 'home-'))
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }))
  vi.stubEnv('TMPDIR', scratch)

  let clock = 1_000
  const bytes = new Map<string, number>()
  const store = new Map<string, { buf: Buffer, mtimeMs: number, ino: number }>()
  let ino = 10
  const sync = (p: string) => {
    try {
      store.set(p, { buf: readFileSync(p), mtimeMs: clock, ino: store.get(p)?.ino ?? ++ino })
    } catch { store.delete(p) }
  }
  const fs: MachineFs = {
    async stat(p) {
      const f = store.get(p)
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { size: f.buf.length, mtimeMs: f.mtimeMs, isFile: true, isDir: false, ino: f.ino }
    },
    statMany: ps => Promise.all(ps.map(p => fs.stat(p).catch(() => null))),
    readdir: async () => [],
    readFile: async () => '',
    async read(p, start, len) {
      const f = store.get(p)
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      bytes.set(p, (bytes.get(p) ?? 0) + len)
      return Buffer.from(f.buf.subarray(start, start + len))
    },
  }

  const sid = '33333333-3333-4444-8555-000000000001'
  const live = openAgyFixture(home, {
    session: sid,
    wal: true,
    model: 'gemini-3-pro',
    modelLabel: 'Gemini 3 Pro',
    rows: [{ role: 'user', text: 'Init' }, { role: 'agent', text: 'Ok' }],
  })
  cleanups.push(() => live.close())
  sync(live.file)
  sync(`${live.file}-wal`)

  const agy = createAgyTranscripts({ home, fs, now: () => clock })
  let isPaneViewed = true
  const ctl = createModelCtl({
    transcript: (p, opts) => agy.model({ id: p.id, agent: p.agent, cwd: p.cwd, agentSession: p.agentSession }, opts),
    codexConfig: async () => null,
    machineKey: () => '',
    now: () => clock,
  })
  const refresh = createModelRefresh({
    currentModel: (p, opts) => ctl.currentModel(p, undefined, opts),
    viewed: () => isPaneViewed,
    now: () => clock,
  })
  const p = { id: 'p1', agent: 'agy', cwd: '/work/proj', agentSession: sid, status: 'working' } as Pane

  // 1. Viewed poll populates kept copy and model.
  refresh.apply(p)
  await new Promise(r => setTimeout(r, 15))
  refresh.apply(p)
  expect(p.model).toMatchObject({ id: 'gemini-3-pro', label: 'Gemini 3 Pro' })
  const dbBytesAfterOpen = bytes.get(live.file) ?? 0
  expect(dbBytesAfterOpen).toBeGreaterThan(0)

  // 2. Unviewed steady poll reads 0 DB and 0 WAL bytes even after 6s (> staleMs).
  isPaneViewed = false
  bytes.clear()
  live.append([{ idx: 10, role: 'agent', text: 'More work' }])
  sync(`${live.file}-wal`)
  clock += 6_000
  refresh.apply(p)
  await new Promise(r => setTimeout(r, 15))
  expect(bytes.get(live.file) ?? 0).toBe(0)
  expect(bytes.get(`${live.file}-wal`) ?? 0).toBe(0)

  // 3. Status flip while unviewed reads ONLY WAL tail (0 main DB bytes).
  p.status = 'idle'
  refresh.apply(p)
  await new Promise(r => setTimeout(r, 15))
  expect(bytes.get(live.file) ?? 0).toBe(0)
  expect(bytes.get(`${live.file}-wal`) ?? 0).toBeGreaterThan(0)

  // 4. Even after a checkpoint while unviewed, status flip NEVER copies main DB.
  bytes.clear()
  live.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  live.append([{ idx: 11, role: 'agent', text: 'After checkpoint' }])
  sync(live.file)
  sync(`${live.file}-wal`)
  p.status = 'working'
  refresh.apply(p)
  await new Promise(r => setTimeout(r, 15))
  expect(bytes.get(live.file) ?? 0).toBe(0)
})

it('skips DB/remote reads for unviewed devin, opencode, hermes and cline panes', async () => {
  let dbCalls = 0
  let previewCalls = 0
  let clock = 1_000
  const ctl = createModelCtl({
    transcript: async () => { dbCalls++; return { id: 'db', label: 'From DB' } },
    codexConfig: async () => null,
    machineKey: () => '',
    now: () => clock,
  })
  const refresh = createModelRefresh({
    currentModel: (p, opts) => ctl.currentModel(p, undefined, opts),
    viewed: () => false,
    now: () => clock,
  })
  const previews = createCorePreviews({
    reply: async () => { previewCalls++; return { text: 'From DB' } },
    read: async () => 'Screen preview line\n',
    viewed: () => false,
    now: () => clock,
  })

  const agents = ['agy', 'devin', 'opencode', 'hermes', 'cline'] as const
  const panes: Pane[] = agents.map((agent, i) => ({
    id: `u${i}`, coreAddress: `host-a/t${i}`, agent, status: 'working', stateSeq: 1,
  } as Pane))
  ctl.noteScreen('u0', 'agy', '?\nauto · Gemini 3 Pro')
  ctl.noteScreen('u1', 'devin', '────────────────────────\nFusion · bypass\n')

  for (let tick = 0; tick < 5; tick++) {
    clock += 6_000
    for (const p of panes) refresh.apply(p)
    previews.apply(panes)
    await new Promise(r => setTimeout(r, 5))
  }

  expect(dbCalls).toBe(0)
  expect(previewCalls).toBe(0)
  expect(panes[0]?.model?.label).toBe('Gemini 3 Pro')
  expect(panes[1]?.model?.label).toBe('Fusion')
})
