import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const sendNotification = vi.fn()
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    setVapidDetails: () => {},
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-push-'))
let push: typeof import('../server/utils/push')

beforeAll(async () => {
  process.env.DATA_DIR = dir
  process.env.APP_URL = 'https://wherdr.example/'
  vi.resetModules()
  push = await import('../server/utils/push')
  push.initVapid()
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const sub = (endpoint: string): import('../server/utils/push').PushSub =>
  ({ endpoint, keys: { p256dh: 'k', auth: 'a' }, lang: 'fr', addedAt: '2026-01-01T00:00:00.000Z' })

describe('envoi Web Push', () => {
  it('keeps a subscription saved during sending and marks the expired device instead of dropping it', async () => {
    await push.writeSubs([sub('https://push.example/dead'), sub('https://push.example/live')])
    sendNotification.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint.endsWith('/dead')) {
        // A new device subscribes while sending is in progress.
        await push.writeSubs([...await push.readSubs(), sub('https://push.example/new')])
        throw Object.assign(new Error('gone'), { statusCode: 410, body: 'secret provider body' })
      }
    })
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' })).toBe(1)
    const subs = await push.readSubs()
    expect(subs.map(s => s.endpoint)).toEqual(['https://push.example/dead', 'https://push.example/live', 'https://push.example/new'])
    expect(subs.map(s => s.last?.status)).toEqual(['expired', 'ok', undefined])
    expect(subs[0]!.last!.code).toBe(410)
    expect(fs.readFileSync(path.join(dir, 'push.json'), 'utf8')).not.toContain('secret provider body')
    // An expired device is not tried again.
    sendNotification.mockClear()
    sendNotification.mockResolvedValue(undefined)
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' })).toBe(2)
    expect(sendNotification.mock.calls.map(c => (c[0] as { endpoint: string }).endpoint)).not.toContain('https://push.example/dead')
  })

  it('records each device\'s own result: one success does not hide another failure', async () => {
    await push.writeSubs([sub('https://push.example/a'), sub('https://push.example/b'), sub('https://push.example/c')])
    sendNotification.mockReset()
    sendNotification.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint.endsWith('/b')) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
      if (s.endpoint.endsWith('/c')) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    })
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' })).toBe(1)
    const views = push.pushDeviceViews(await push.readSubs(), 'https://push.example/b')
    expect(views.map(v => [v.last?.status, v.last?.code, v.current])).toEqual([['ok', undefined, false], ['rejected', 403, true], ['network', undefined, false]])
    expect(views.every(v => /^[0-9a-f]{16}$/.test(v.id))).toBe(true)
    expect(JSON.stringify(views)).not.toContain('push.example')
    // A later success on b replaces its failure without touching c.
    sendNotification.mockReset()
    sendNotification.mockResolvedValue(undefined)
    await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' }, s => s.endpoint.endsWith('/b'))
    expect((await push.readSubs()).map(s => s.last?.status)).toEqual(['ok', 'ok', 'network'])
  })

  it('drops a device expired for longer than the keep delay', () => {
    const now = Date.parse('2026-06-01T00:00:00Z')
    const old = { ...sub('https://push.example/old'), last: { at: '2026-04-01T00:00:00.000Z', status: 'expired' as const, code: 410 } }
    const recent = { ...sub('https://push.example/recent'), last: { at: '2026-05-30T00:00:00.000Z', status: 'expired' as const, code: 410 } }
    expect(push.recordDeliveries([old, recent], new Map(), now).map(s => s.endpoint)).toEqual(['https://push.example/recent'])
  })

  it('sends each device its language, English by default', async () => {
    const en = { ...sub('https://push.example/en'), lang: 'en' as const }
    const old = { ...sub('https://push.example/old'), lang: undefined as unknown as 'en' }
    await push.writeSubs([sub('https://push.example/fr'), en, old])
    const got: Record<string, { title: string, body: string, titleFr?: string }> = {}
    sendNotification.mockReset()
    sendNotification.mockImplementation(async (s: { endpoint: string }, body: string) => { got[s.endpoint.split('/').pop()!] = JSON.parse(body) })
    const { title, titleFr } = push.agentNotificationTitle('blocked', 'Claude')
    expect(await push.pushSend({ title, titleFr, body: 'Run it?', tag: 'x', url: '/' })).toBe(3)
    expect(got.fr!.title).toBe('Claude attend ta réponse')
    expect(got.en!.title).toBe('Claude needs your input')
    expect(got.old!.title).toBe('Claude needs your input')
    expect(got.en!.body).toBe('Run it?')
    expect(got.fr!.titleFr).toBeUndefined()
  })

  it('Do not disturb drops every notification, whatever the notification rules allowed', async () => {
    await push.writeSubs([sub('https://push.example/a'), { ...sub('https://push.example/b'), quiet: { until: null } }])
    sendNotification.mockReset()
    sendNotification.mockResolvedValue(undefined)
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' })).toBe(1)
    await push.writeGlobalQuiet({ until: null })
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' })).toBe(0)
    // The explicit test notification still goes through.
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' }, undefined, true)).toBe(2)
    await push.writeGlobalQuiet(null)
  })
})

describe('Web Push after Lock all devices', () => {
  it('sends nothing to a subscription saved under an earlier lock generation, and removes it', async () => {
    const { auth } = await import('../server/utils/http')
    auth._db().credentials.push({ id: 'k1', publicKey: 'x', counter: 0, transports: [], name: 'iPhone', createdAt: '2026-01-01T00:00:00.000Z' })
    const cookie = auth._sessionCookie({ headers: {} }).split(';')[0]!
    const before = auth.generation()
    // Subscribed while unlocked; an untagged one comes from an earlier version.
    await push.writeSubs([{ ...sub('https://push.example/phone'), gen: before }, sub('https://push.example/legacy')])
    sendNotification.mockReset()
    sendNotification.mockResolvedValue(undefined)
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' })).toBe(2)

    auth.lockAll({ headers: { cookie } })
    expect(auth.generation()).not.toBe(before)
    sendNotification.mockClear()
    // Even when the subscription is still on disk (saved by a request under way).
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' }, undefined, true)).toBe(1)
    expect(sendNotification.mock.calls.map(c => (c[0] as { endpoint: string }).endpoint)).toEqual(['https://push.example/legacy'])
    expect((await push.readSubs()).map(s => s.endpoint)).toEqual(['https://push.example/legacy'])

    // The Lock all devices route drops every subscription, untagged ones included.
    expect(await push.dropAllSubs()).toBe(1)
    sendNotification.mockClear()
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' }, undefined, true)).toBe(0)
    expect(sendNotification).not.toHaveBeenCalled()
    // Once unlocked again, the device subscribes under the new generation.
    await push.writeSubs([{ ...sub('https://push.example/phone'), gen: auth.generation() }])
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' }, undefined, true)).toBe(1)
  })
})

describe('subscriptions file', () => {
  it('devices subscribing at the same time all stay listed', async () => {
    await push.writeSubs([])
    await Promise.all(['a', 'b', 'c'].map(n => push.updateSubs(all => [...all, sub(`https://push.example/${n}`)])))
    expect((await push.readSubs()).map(s => s.endpoint).sort()).toEqual(['a', 'b', 'c'].map(n => `https://push.example/${n}`))
  })
  it('an unreadable file is never written over with an empty list', async () => {
    const file = path.join(dir, 'push.json')
    fs.writeFileSync(file, '{"subs":[{"endpoint":"https://push.example/a"')
    await expect(push.dropAllSubs()).rejects.toThrow()
    await expect(push.updateSubs(all => all)).rejects.toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('{"subs":[{"endpoint":"https://push.example/a"')
    expect(await push.readSubs()).toEqual([])
  })
})
