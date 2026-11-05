// Lock: signed session cookie, generation, data/auth.json format.
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAuth, type Auth } from '../server/utils/auth'
import { createRateLimit } from '../server/utils/rateLimit'

const dir = () => mkdtempSync(path.join(tmpdir(), 'hw-auth-'))
const req = (cookie?: string, origin = 'http://localhost:7684') => ({ headers: { cookie, origin } })
const H = 3600 * 1000
const D = 24 * H
const cookieValue = (setCookie: string) => setCookie.split(';')[0]!
// A fake key is enough: isUnlocked only looks at their count.
const withKey = (a: ReturnType<typeof createAuth>) => {
  a._db().credentials.push({ id: 'k1', publicKey: 'x', counter: 0, transports: [], name: 'iPhone', createdAt: '2026-01-01T00:00:00.000Z' })
}

describe('auth', () => {
  it('creates data/auth.json (secret, random generation, no key) on first startup', () => {
    const d = dir()
    createAuth({ dataDir: d })
    const db = JSON.parse(readFileSync(path.join(d, 'auth.json'), 'utf8'))
    expect(db.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(db.generation).toMatch(/^[\w-]{24}$/)
    expect(db.credentials).toEqual([])
  })

  it('stays open as long as no key is registered', () => {
    const a = createAuth({ dataDir: dir() })
    expect(a.isUnlocked(req())).toBe(true)
    expect(a.status(req())).toEqual({ enabled: false, unlocked: true, devices: [] })
  })

  it('requires a valid signed cookie as soon as a key exists', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    expect(a.isUnlocked(req())).toBe(false)
    const c = a._sessionCookie(req())
    // The cookie outlives the longest duration offered (365 days + 12 h): the server decides.
    expect(c).toMatch(/^hw_session=\d+\.[\w-]{24}\.\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=31579200$/)
    expect(a.isUnlocked(req(cookieValue(c)))).toBe(true)
    expect(a.status(req(cookieValue(c)))).toMatchObject({ enabled: true, unlocked: true, devices: [{ name: 'iPhone' }] })
  })

  it('refuses a modified or expired cookie', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const v = cookieValue(a._sessionCookie(req()))
    expect(a.isUnlocked(req(v.slice(0, -2) + 'xx'))).toBe(false)
    const [exp, gen, since, mac] = v.replace('hw_session=', '').split('.')
    expect(a.isUnlocked(req(`hw_session=${Number(exp) + 1000}.${gen}.${since}.${mac}`))).toBe(false)
    // The unlock time is signed too: moving it later does not buy more time.
    expect(a.isUnlocked(req(`hw_session=${exp}.${gen}.${Number(since) + 1000}.${mac}`))).toBe(false)
    // Unlocked 8 days ago (default: 7 days) and never reopened: cut.
    const old = cookieValue(a._sessionCookie(req(), Date.now() - 8 * 24 * 3600 * 1000))
    expect(a.isUnlocked(req(old))).toBe(false)
  })

  it('disabling invalidates all sessions (new secret and generation)', () => {
    const d = dir()
    const a = createAuth({ dataDir: d })
    withKey(a)
    const before = { ...a._db() }
    const v = cookieValue(a._sessionCookie(req()))
    const r = a.disable(req(v))
    expect(r.__cookie).toMatch(/Max-Age=0/)
    const saved = JSON.parse(readFileSync(path.join(d, 'auth.json'), 'utf8'))
    expect(saved.generation).not.toBe(before.generation)
    expect(saved.secret).not.toBe(before.secret)
    withKey(a)
    expect(a.isUnlocked(req(v))).toBe(false)
  })

  it('verrouiller efface le cookie ; Secure en HTTPS', () => {
    const a = createAuth({ dataDir: dir() })
    expect(a.lock(req()).__cookie).toBe('hw_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    expect(a.lock(req(undefined, 'https://herdr.example.ts.net:8103')).__cookie).toMatch(/; Secure$/)
  })

  it('re-reads an existing data/auth.json (previous version format): numeric generation replaced, keys kept', () => {
    const d = dir()
    const secret = 'ab'.repeat(32)
    const credential = { id: 'k', publicKey: 'x', counter: 5, transports: ['internal'], name: 'Laptop', createdAt: '2026-09-25T10:00:00.000Z' }
    writeFileSync(path.join(d, 'auth.json'), JSON.stringify({ secret, generation: 3, credentials: [credential] }))
    // A cookie of the earlier version, generation 3.
    const p = `${Date.now() + D}.3.${Date.now()}`
    const oldCookie = `hw_session=${p}.${createHmac('sha256', secret).update(p).digest('base64url')}`
    const a = createAuth({ dataDir: d })
    expect(a.status(req())).toMatchObject({ enabled: true, unlocked: false, devices: [] })
    expect(a.status(req(cookieValue(a._sessionCookie(req()))))).toMatchObject({ devices: [{ name: 'Laptop', lastUsed: null }] })
    const saved = JSON.parse(readFileSync(path.join(d, 'auth.json'), 'utf8'))
    expect(saved.generation).toMatch(/^[\w-]{24}$/)
    expect(saved.credentials).toEqual([credential])
    // The earlier version's sessions end once; a passkey unlock opens again.
    expect(a.isUnlocked(req(oldCookie))).toBe(false)
    const v = cookieValue(a._sessionCookie(req()))
    expect(a.isUnlocked(req(v))).toBe(true)
    // Read again at the next start: the same generation, sessions kept.
    expect(createAuth({ dataDir: d }).isUnlocked(req(v))).toBe(true)
  })

  it('refuses to add a key without being unlocked', async () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    await expect(a.registerOptions(req())).rejects.toMatchObject({ code: 'locked' })
  })

  it('never re-issues a current cookie (no slide, no Set-Cookie churn)', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const now = Date.now()
    expect(a.renew(req(cookieValue(a._sessionCookie(req(), now - 5 * 60 * 1000))), now)).toBeNull()
    expect(a.renew(req(cookieValue(a._sessionCookie(req(), now - 3 * 24 * 3600 * 1000))), now)).toBeNull()
    expect(a.renew(req(), now)).toBeNull()
  })

  it('reports the server clock with the expiry', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const st = a.status(req(cookieValue(a._sessionCookie(req()))))
    expect(Math.abs(st.now! - Date.now())).toBeLessThan(1000)
    // expiresAt: deadline (7 days by default) + 12 h for a client that never reopens.
    expect(st.expiresAt! - st.deadline!).toBe(12 * 3600 * 1000)
    expect(a.status(req()).expiresAt).toBeNull()
  })
})

describe('auth: the chosen duration is the only rule', () => {
  // The cookie of a passkey unlock `ago` old (it is never re-issued since).
  const unlocked = (a: Auth, now: number, ago: number) =>
    req(cookieValue(a._sessionCookie(req(), now - ago, now - ago)))

  it('does not lock an unused device before the duration, whatever the idle time', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const now = Date.now()
    a.setMaxSession(unlocked(a, now, 0), 30, now - 40 * D)
    // 13 h, 29 days without any request: opening the app keeps the session.
    expect(a.status(unlocked(a, now, 13 * H), { resume: true, now })).toMatchObject({ unlocked: true, deadline: now + 30 * D - 13 * H })
    expect(a.status(unlocked(a, now, 29 * D), { resume: true, now })).toMatchObject({ unlocked: true, maxSessionDays: 30 })
    // 31 days: past the duration, the passkey is asked again.
    const late = a.status(unlocked(a, now, 31 * D), { resume: true, now })
    expect(late).toMatchObject({ enabled: true, unlocked: false, expiresAt: null })
    expect(late).not.toHaveProperty('deadline')
    // 1 day: 13 h without use still opens, 25 h does not.
    a.setMaxSession(unlocked(a, now, 0), 1, now - 40 * D)
    expect(a.status(unlocked(a, now, 13 * H), { resume: true, now }).unlocked).toBe(true)
    expect(a.status(unlocked(a, now, 25 * H), { resume: true, now }).unlocked).toBe(false)
  })

  it('keeps a session past the deadline while in use, and ends it at the next opening', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const now = Date.now()
    const r = unlocked(a, now, 7 * D + 60 * 1000) // default: 7 days
    // Never in the middle of use: plain status checks still pass.
    expect(a.status(r, { now })).toMatchObject({ unlocked: true, deadline: now - 60 * 1000, maxSessionDays: 7 })
    const opened = a.status(r, { resume: true, now })
    expect(opened).toMatchObject({ enabled: true, unlocked: false, expiresAt: null })
    expect(opened.__cookie).toMatch(/^hw_session=; .*Max-Age=0/)
  })

  it('cuts a client that never reopens 12 h after the deadline', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const now = Date.now()
    expect(a.isUnlocked(unlocked(a, now, 7 * D + 11 * H))).toBe(true)
    expect(a.isUnlocked(unlocked(a, now, 7 * D + 12 * H + 60 * 1000))).toBe(false)
    expect(a.renew(unlocked(a, now, 7 * D + 12 * H + 60 * 1000), now)).toBeNull()
  })

  it('applies a changed duration to open sessions and keeps it in data/auth.json', () => {
    const d = dir()
    const a = createAuth({ dataDir: d })
    withKey(a)
    const now = Date.now()
    const twoDays = unlocked(a, now, 2 * D)
    expect(a.status(twoDays, { resume: true, now }).unlocked).toBe(true)
    // 30 → 1 day: the next opening asks again; a session in use is only cut
    // 12 h after the change, not on the spot.
    expect(a.setMaxSession(twoDays, 1, now)).toEqual({ ok: true, maxSessionDays: 1 })
    expect(a.status(twoDays, { now: now + 11 * H }).unlocked).toBe(true)
    expect(a.status(twoDays, { now: now + 13 * H }).unlocked).toBe(false)
    expect(a.status(twoDays, { resume: true, now }).unlocked).toBe(false)
    // 1 → 30 days: a device unlocked 10 days ago and unused since opens again
    // (its cookie outlives every duration offered).
    const tenDays = a._sessionCookie(req(), now - 10 * D, now - 10 * D)
    expect(Number(tenDays.match(/Max-Age=(\d+)/)![1]) * 1000).toBeGreaterThan(355 * D)
    a.setMaxSession(unlocked(a, now, 0), 30, now)
    expect(a.status(req(cookieValue(tenDays)), { resume: true, now })).toMatchObject({ unlocked: true, maxSessionDays: 30, deadline: now + 20 * D })
    const saved = JSON.parse(readFileSync(path.join(d, 'auth.json'), 'utf8'))
    expect(saved).toMatchObject({ maxSessionDays: 30, maxSessionChangedAt: now })
    expect(createAuth({ dataDir: d }).status(req(cookieValue(tenDays)), { now }).maxSessionDays).toBe(30)
  })

  it('only lets an unlocked session pick one of the offered durations', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const now = Date.now()
    expect(() => a.setMaxSession(req(), 30)).toThrow(expect.objectContaining({ code: 'locked' }))
    for (const bad of [0, 2, 3650, '7', null]) {
      expect(() => a.setMaxSession(unlocked(a, now, 0), bad)).toThrow(expect.objectContaining({ code: 'invalid' }))
    }
    expect(a._db().maxSessionDays).toBeUndefined()
  })

  it('moves a 12 h cookie from an earlier version to the new regime without a passkey', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const now = Date.now()
    const sign = (v: string) => createHmac('sha256', a._db().secret!).update(v).digest('base64url')
    // exp.gen.since.mac, renewed an hour ago, passkey unlock 3 days ago.
    const g = a._db().generation
    const v = `${now + 11 * H}.${g}.${now - 3 * D}`
    const old = { headers: { cookie: `hw_session=${v}.${sign(v)}` } }
    expect(a.isUnlocked(old)).toBe(true)
    const renewed = a.renew(old, now)!
    expect(cookieValue(renewed.cookie).split('.')[2]).toBe(String(now - 3 * D))
    expect(Number(renewed.cookie.match(/Max-Age=(\d+)/)![1]) * 1000).toBeGreaterThan(360 * D)
    expect(a.renew(req(cookieValue(renewed.cookie)), now)).toBeNull()
    // Older format exp.gen.mac: counted from its last renewal.
    const exp = now + 11 * H
    const legacy = { headers: { cookie: `hw_session=${exp}.${g}.${sign(`${exp}.${g}`)}` } }
    expect(a.isUnlocked(legacy)).toBe(true)
    expect(cookieValue(a.renew(legacy, now)!.cookie).split('.')[2]).toBe(String(exp - 12 * H))
  })
})

describe('auth: lock all devices', () => {
  it('ends every session, this one included, and keeps the keys', () => {
    const d = dir()
    const a = createAuth({ dataDir: d })
    withKey(a)
    const mine = req(cookieValue(a._sessionCookie(req())))
    const other = req(cookieValue(a._sessionCookie(req())))
    expect(a.lockAll(mine).__cookie).toMatch(/Max-Age=0/)
    expect(a.isUnlocked(mine)).toBe(false)
    expect(a.isUnlocked(other)).toBe(false)
    const saved = JSON.parse(readFileSync(path.join(d, 'auth.json'), 'utf8'))
    expect(saved.credentials).toHaveLength(1)
    // A new passkey unlock opens again.
    expect(a.isUnlocked(req(cookieValue(a._sessionCookie(req()))))).toBe(true)
  })

  it('defeats a cookie forged with a copy of auth.json read before', () => {
    const d = dir()
    const a = createAuth({ dataDir: d })
    withKey(a)
    const leaked = JSON.parse(readFileSync(path.join(d, 'auth.json'), 'utf8'))
    const forge = (generation: string) => {
      const p = `${Date.now() + D}.${generation}.${Date.now()}`
      return req(`hw_session=${p}.${createHmac('sha256', leaked.secret).update(p).digest('base64url')}`)
    }
    expect(a.isUnlocked(forge(leaked.generation))).toBe(true)
    a.lockAll(req(cookieValue(a._sessionCookie(req()))))
    const now = JSON.parse(readFileSync(path.join(d, 'auth.json'), 'utf8'))
    expect(now.secret).not.toBe(leaked.secret)
    expect(now.generation).not.toBe(leaked.generation)
    // Even guessing the new generation is useless without the new secret.
    expect(a.isUnlocked(forge(leaked.generation))).toBe(false)
    expect(a.isUnlocked(forge(now.generation))).toBe(false)
    // The same holds after a restart.
    expect(createAuth({ dataDir: d }).isUnlocked(forge(now.generation))).toBe(false)
  })

  it('refuses a locked request', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const before = { ...a._db() }
    expect(() => a.lockAll(req())).toThrow(expect.objectContaining({ code: 'locked' }))
    expect(a._db()).toMatchObject({ generation: before.generation, secret: before.secret })
  })
})

describe('auth: damaged cookie', () => {
  it('stays locked without throwing', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    expect(a.isUnlocked(req('hw_session=%E0%A4%A'))).toBe(false)
    expect(a.status(req('hw_session=%E0%A4%A')).unlocked).toBe(false)
  })
})

describe('auth: nothing leaks before the unlock', () => {
  it('gives a locked client no key names, dates or server clock', () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const locked = a.status(req())
    expect(locked).toEqual({ enabled: true, unlocked: false, expiresAt: null, devices: [] })
    const open = a.status(req(cookieValue(a._sessionCookie(req()))))
    expect(open.devices).toEqual([{ name: 'iPhone', createdAt: '2026-01-01T00:00:00.000Z', lastUsed: null }])
  })

  it('unlock options list no key id (discoverable passkeys), registration requires one', async () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const opts = await a.loginOptions(req())
    expect(opts.allowCredentials ?? []).toEqual([])
    // The challenge and the challenge cookie are random base64 and may contain 'k1' by chance.
    const { challenge, __cookie, ...rest } = opts
    expect(challenge).toEqual(expect.any(String))
    expect(__cookie).toEqual(expect.any(String))
    expect(JSON.stringify(rest)).not.toContain('k1')
    const reg = await a.registerOptions(req(cookieValue(a._sessionCookie(req()))))
    expect(reg.authenticatorSelection).toMatchObject({ residentKey: 'required', requireResidentKey: true })
  })

  it('keeps at most 100 pending challenges, the oldest dropped first', async () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const first = await a.loginOptions(req(), 'c0')
    for (let i = 1; i < 150; i++) await a.loginOptions(req(), `c${i}`)
    expect(a._challengeCount()).toBe(100)
    // The first client's challenge is gone: its answer is refused.
    const client = first.__cookie.split(';')[0]!
    expect(() => a._takeChallenge({ headers: { cookie: client } }, 'auth')).toThrow(/expired/)
  })

  it('rate-limits unlock options per client', async () => {
    const a = createAuth({ dataDir: dir() })
    withKey(a)
    const now = Date.now()
    for (let i = 0; i < 10; i++) await a.loginOptions(req(), 'phone', now)
    await expect(a.loginOptions(req(), 'phone', now)).rejects.toMatchObject({ code: 'rate_limited' })
    // Another client is not affected, and the same one may try again a minute later.
    await expect(a.loginOptions(req(), 'laptop', now)).resolves.toHaveProperty('challenge')
    await expect(a.loginOptions(req(), 'phone', now + 60_000)).resolves.toHaveProperty('challenge')
  })
})

describe('createRateLimit', () => {
  it('bounds its table of clients', () => {
    const r = createRateLimit(1, 1000, 50)
    for (let i = 0; i < 500; i++) r.take(`ip${i}`, 0)
    expect(r._size()).toBe(50)
    expect(r.take('ip499', 0)).toBe(false)
  })
})
