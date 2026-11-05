// A 2.x user's data folder on v3: tests/fixtures/data-2.5.0 holds the files
// wherdr 2.5.0 writes (same shapes as the v2.5.0 tag, every value fake). v3
// must start on a copy of it and keep the passkey, the push devices, the
// phone address and the recent folders; settings keys v3 does not know are
// dropped without an error.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const FIXTURE = path.join(__dirname, 'fixtures/data-2.5.0')

// Before the server modules load: a copy of the fixture as the data folder,
// and no APP_URL from the environment (the saved phone address must win).
const data = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/wherdr-data250-${process.pid}`
  process.env.DATA_DIR = dir
  delete process.env.APP_URL
  return { dir }
})

const sendNotification = vi.fn()
const vapidDetails = vi.fn()
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => { throw new Error('the saved VAPID keys must be reused') },
    setVapidDetails: (...args: unknown[]) => vapidDetails(...args),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}))

// The fixture's passkey is fake: the WebAuthn check is stubbed, and records
// the stored credential v3 hands to it.
const verifyAuth = vi.fn()
vi.mock('@simplewebauthn/server', async orig => ({
  ...await orig<typeof import('@simplewebauthn/server')>(),
  verifyAuthenticationResponse: (...args: unknown[]) => verifyAuth(...args),
}))

const fixture = (name: string) => JSON.parse(readFileSync(path.join(FIXTURE, name), 'utf8'))
const saved = (name: string) => JSON.parse(readFileSync(path.join(data.dir, name), 'utf8'))
const ORIGIN = 'https://box.example.ts.net:8103'

beforeAll(() => {
  rmSync(data.dir, { recursive: true, force: true })
  cpSync(FIXTURE, data.dir, { recursive: true })
})
afterAll(() => rmSync(data.dir, { recursive: true, force: true }))

describe('2.5.0 data folder on v3', () => {
  it('keeps the passkey: the numeric generation migrates and an unlock issues a session cookie', async () => {
    const { auth } = await import('../server/utils/http')
    const old = fixture('auth.json')
    const db = saved('auth.json')
    // #354: the predictable counter becomes a random nonce; the rest stays.
    expect(db.generation).toMatch(/^[\w-]{24}$/)
    expect(db).toMatchObject({ secret: old.secret, credentials: old.credentials, maxSessionDays: 30 })
    expect(auth.isEnabled()).toBe(true)

    // A 2.5.0 cookie (generation 4) ends once.
    const { createHmac } = await import('node:crypto')
    const p = `${Date.now() + 3600_000}.4.${Date.now()}`
    const oldCookie = `hw_session=${p}.${createHmac('sha256', old.secret).update(p).digest('base64url')}`
    expect(auth.isUnlocked({ headers: { cookie: oldCookie } })).toBe(false)

    // Unlocking with the stored passkey works and gives a valid session.
    const options = await auth.loginOptions({ headers: { origin: ORIGIN } }, 'phone')
    const challenge = options.__cookie.split(';')[0]!
    verifyAuth.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 13 } })
    const res = await auth.loginVerify({ headers: { origin: ORIGIN, cookie: challenge } }, { response: { id: old.credentials[0].id } })
    const stored = old.credentials[0]
    expect(verifyAuth.mock.calls[0]![0]).toMatchObject({
      expectedOrigin: ORIGIN, expectedRPID: 'box.example.ts.net',
      credential: { id: stored.id, publicKey: Buffer.from(stored.publicKey, 'base64url'), counter: 12, transports: ['internal', 'hybrid'] },
    })
    const cookie = res.__cookie.split(';')[0]!
    expect(cookie).toContain(`.${db.generation}.`)
    expect(auth.status({ headers: { cookie } })).toMatchObject({ enabled: true, unlocked: true, maxSessionDays: 30, devices: [{ name: 'iPhone' }] })
    expect(saved('auth.json').credentials[0]).toMatchObject({ id: stored.id, counter: 13 })
  })

  it('keeps the phone address: APP_URL follows app-url.json and Web Push uses the saved VAPID keys', async () => {
    const env = await import('../server/utils/env')
    expect(env.savedAppUrl()).toBe(`${ORIGIN}/`)
    expect(process.env.APP_URL).toBe(`${ORIGIN}/`)
    const push = await import('../server/utils/push')
    push.initVapid()
    expect(push.vapidPublicKey()).toBe(fixture('vapid.json').publicKey)
    expect(vapidDetails).toHaveBeenCalledWith(`${ORIGIN}/`, fixture('vapid.json').publicKey, fixture('vapid.json').privateKey)
    expect(saved('vapid.json')).toEqual(fixture('vapid.json'))
    expect(saved('app-url.json')).toEqual(fixture('app-url.json'))
  })

  it('keeps the push subscriptions (saved without a lock generation) and still delivers to them', async () => {
    const push = await import('../server/utils/push')
    const { auth } = await import('../server/utils/http')
    const subs = await push.readSubs()
    expect(subs).toEqual(fixture('push.json').subs)
    expect(subs.some(s => push.staleSub(s, auth.generation()))).toBe(false)
    expect(push.pushDeviceViews(subs).map(v => [v.provider, v.lang])).toEqual([['apple', 'fr'], ['google', 'en']])

    sendNotification.mockResolvedValue(undefined)
    expect(await push.pushSend({ title: 't', body: 'b', tag: 'x', url: '/' })).toBe(2)
    expect((await push.readSubs()).map(s => s.endpoint)).toEqual(subs.map(s => s.endpoint))
  })

  it('reads settings.json: Board keys kept, v2-only and malformed keys dropped, writes still work', async () => {
    const { readSettings, patchSettings } = await import('../server/utils/settings')
    const s = await readSettings()
    expect(s).toEqual({
      theme: 'herdr-dark', compactListV2: '1', notificationRules: '{"blocked":true,"done":false}',
      boardGrouping: 'status', boardDone: 'hide', boardFolds: '["wherdr/12","wherdr/40"]',
    })
    expect(await patchSettings({ theme: 'herdr-light' })).toMatchObject({ theme: 'herdr-light', boardGrouping: 'status' })
    expect(saved('settings.json')).toMatchObject({ v: 1, settings: { theme: 'herdr-light' } })
  })

  it('keeps the recent folders of the local and remote machines', async () => {
    const { recentDirs } = await import('../server/utils/actions')
    const dirs = fixture('dirs.json')
    expect(await recentDirs({ local: true, key: '', profileId: undefined })).toEqual(dirs.dirs)
    expect(await recentDirs({ local: false, key: 'lap', profileId: 'profile-laptop' })).toEqual(dirs.machines['profile-laptop'])
  })
})
