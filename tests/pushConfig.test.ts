import { describe, expect, it } from 'vitest'
import { FALLBACK_VAPID_SUBJECT, knownPushService, pushConfig, replaceSubscription, validPushSubscription } from '../server/utils/pushConfig'

describe('configuration Web Push', () => {
  it('disables push with APP_URL on local HTTP', () => {
    expect(pushConfig('http://localhost:7683')).toEqual({ enabled: false, subject: FALLBACK_VAPID_SUBJECT })
  })

  it('keeps a private HTTPS address as the VAPID subject', () => {
    expect(pushConfig('https://server.example.ts.net:7683/')).toEqual({ enabled: true, subject: 'https://server.example.ts.net:7683/' })
  })

  it('disables push with an empty or invalid APP_URL', () => {
    for (const value of ['', 'not a URL', 'https://', 'ftp://server.example']) {
      expect(pushConfig(value)).toEqual({ enabled: false, subject: FALLBACK_VAPID_SUBJECT })
    }
  })
})

describe('received Web Push subscription', () => {
  const keys = { p256dh: 'BPk', auth: 'aut' }
  it('accepts an HTTPS subscription with its keys', () => {
    expect(validPushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys })).toBe(true)
  })
  it('accepts the push services of the browsers only', () => {
    for (const e of ['https://web.push.apple.com/QK', 'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
      expect(validPushSubscription({ endpoint: e, keys }), e).toBe(true)
    }
    for (const e of ['https://push.example/abc', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://192.168.1.10/x', 'https://box.example.ts.net/x',
      'https://fcm.googleapis.com.evil.com/x', 'https://evilpush.apple.com/x', 'https://push.apple.com.evil.com/x', 'https://fcm.googleapis.com:8443/x', 'https://u@fcm.googleapis.com/x']) {
      expect(validPushSubscription({ endpoint: e, keys }), e).toBe(false)
    }
    expect(knownPushService('WEB.PUSH.APPLE.COM')).toBe(true)
    expect(knownPushService('push.apple.com')).toBe(false)
  })
  it('refuses a non-HTTPS address (the server would post to it)', () => {
    expect(validPushSubscription({ endpoint: 'http://127.0.0.1:7683/api/x', keys })).toBe(false)
    expect(validPushSubscription({ endpoint: 'file:///etc/passwd', keys })).toBe(false)
    expect(validPushSubscription({ endpoint: 'pas une adresse', keys })).toBe(false)
  })
  it('refuses missing or malformed keys', () => {
    expect(validPushSubscription({ endpoint: 'https://fcm.googleapis.com/x' })).toBe(false)
    expect(validPushSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 1, auth: 'a' } })).toBe(false)
    expect(validPushSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: true })).toBe(false)
    expect(validPushSubscription(null)).toBe(false)
  })
})

describe('replaceSubscription', () => {
  const active = (q: { until: number | null }) => q.until === null || q.until > 1000
  const sub = (endpoint: string, quiet?: { until: number | null }) => ({ endpoint, lang: 'fr', ...(quiet ? { quiet } : {}) })
  it('drops the previous endpoint and carries its quiet mode over', () => {
    const out = replaceSubscription([sub('https://p/old', { until: null }), sub('https://p/other')], sub('https://p/new'), 'https://p/old', active)
    expect(out.map(s => s.endpoint)).toEqual(['https://p/other', 'https://p/new'])
    expect(out[1]).toMatchObject({ quiet: { until: null } })
  })
  it('keeps the quiet mode on a plain resubscription and drops an expired one', () => {
    expect(replaceSubscription([sub('https://p/a', { until: 5000 })], sub('https://p/a'), undefined, active)[0]).toMatchObject({ quiet: { until: 5000 } })
    expect(replaceSubscription([sub('https://p/old', { until: 10 })], sub('https://p/new'), 'https://p/old', active)).toEqual([sub('https://p/new')])
  })
  it('ignores a previous endpoint that is not a string', () => {
    const out = replaceSubscription([sub('https://p/a')], sub('https://p/b'), 42, active)
    expect(out.map(s => s.endpoint)).toEqual(['https://p/a', 'https://p/b'])
  })
})
