import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BacklotMachineView, BacklotRole, BacklotStudio } from '../shared/backlot'

const sendNotification = vi.fn()
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    setVapidDetails: () => {},
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-backlot-push-'))
let push: typeof import('../server/utils/push')
let backlotPush: typeof import('../server/utils/backlotPush')

beforeAll(async () => {
  process.env.DATA_DIR = dir
  process.env.APP_URL = 'https://wherdr.example/'
  vi.resetModules()
  push = await import('../server/utils/push')
  backlotPush = await import('../server/utils/backlotPush')
  push.initVapid()
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const sub = {
  endpoint: 'https://push.example/phone',
  keys: { p256dh: 'k', auth: 'a' },
  lang: 'en' as const,
  addedAt: '2026-01-01T00:00:00.000Z',
}

beforeEach(async () => {
  fs.rmSync(path.join(dir, 'backlot-push.json'), { force: true })
  await push.writeSubs([sub])
  await push.writeGlobalQuiet(null)
  sendNotification.mockReset()
  sendNotification.mockResolvedValue(undefined)
})

const role = (more: Partial<BacklotRole> = {}): BacklotRole => ({ role: 'dev', name: 'alice', state: 'live', ...more })
const studio = (more: Partial<BacklotStudio> = {}): BacklotStudio => ({
  id: 'shop', title: 'Acme shop', state: 'live', requirement_version: 1, open_reviews: 0, waiting: 0, roles: [role()], ...more,
})
const view = (more: Partial<BacklotMachineView> = {}): BacklotMachineView => ({
  machine: 'host-a',
  label: 'host-a',
  stageRunning: true,
  backlotVersion: '1.0.0',
  summary: { schema: 'backlot/1', updated_ms: 1, studios: [studio()], hollywood: null },
  ...more,
})
const askingStudio = (more: Partial<BacklotRole> = {}) => studio({
  roles: [role({ attention_user: true, attention_seq: 7, attention_detail: 'Ship v2 today?\nDetails on the next line', asks: 'Ignored fallback', ...more })],
})
const askingView = (more: Partial<BacklotRole> = {}) => view({
  summary: { schema: 'backlot/1', updated_ms: 1, studios: [askingStudio(more)], hollywood: null },
})
const cardView = (why = 'All checks are green\nDetails on the next line') => view({
  summary: {
    schema: 'backlot/1',
    updated_ms: 1,
    studios: [studio()],
    hollywood: { state: 'live', cards: [{ id: 'c9', studio: 'shop', action: 'merge', why }] },
  },
})

const bodies = () => sendNotification.mock.calls.map(c => JSON.parse(c[1] as string) as { title: string, body: string, tag: string, url: string })
const prime = async (watcher = backlotPush.createBacklotPushWatcher()) => {
  await watcher.scan([view()])
  sendNotification.mockClear()
  return watcher
}

describe('backlot ask pushes', () => {
  it('pushes a new ask once, with the first detail line and the studio deep link', async () => {
    const watcher = await prime()
    await watcher.scan([askingView()])
    expect(bodies()).toEqual([
      expect.objectContaining({
        title: 'Acme shop asks',
        body: 'Ship v2 today?',
        url: '/#/?studio=shop&studioMachine=host-a',
      }),
    ])
    await watcher.scan([askingView()])
    expect(bodies()).toHaveLength(1)
  })

  it('truncates the first line like the other long push bodies', async () => {
    const watcher = await prime()
    await watcher.scan([askingView({ attention_detail: `${'x'.repeat(240)}\nsecond line` })])
    expect(bodies()[0]!.body).toBe('x'.repeat(200))
  })

  it('does not push the same seq again, including after a simulated restart', async () => {
    const watcher = await prime()
    await watcher.scan([askingView()])
    expect(bodies()).toHaveLength(1)
    await watcher.scan([askingView()])
    const restarted = backlotPush.createBacklotPushWatcher()
    await restarted.scan([askingView()])
    expect(bodies()).toHaveLength(1)
  })

  it('records items already open on the first run without pushing them', async () => {
    const watcher = backlotPush.createBacklotPushWatcher()
    await watcher.scan([view({
      summary: {
        schema: 'backlot/1',
        updated_ms: 1,
        studios: [askingStudio()],
        hollywood: { state: 'live', cards: [{ id: 'c1', studio: 'shop', action: 'merge', why: 'ready' }] },
      },
    })])
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('pushes a new card with its summary and the studio deep link', async () => {
    const watcher = await prime()
    await watcher.scan([cardView()])
    expect(bodies()).toEqual([
      expect.objectContaining({
        title: 'Acme shop · card',
        body: 'All checks are green',
        url: '/#/?studio=shop&studioMachine=host-a',
      }),
    ])
  })

  it('quiet hours suppress the push without making it repeat later', async () => {
    const watcher = await prime()
    await push.writeGlobalQuiet({ until: null })
    await watcher.scan([askingView()])
    expect(sendNotification).not.toHaveBeenCalled()
    await push.writeGlobalQuiet(null)
    await watcher.scan([askingView()])
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('an acknowledged item (attention_user false) never pushes', async () => {
    const watcher = await prime()
    await watcher.scan([askingView({ attention_user: false, attention_seq: 8, attention_detail: null, asks: 'Already answered' })])
    expect(sendNotification).not.toHaveBeenCalled()
  })
})
