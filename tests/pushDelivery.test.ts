import { describe, expect, it } from 'vitest'
import { EXPIRED_KEEP_MS, classifyPushError, expiredLongAgo, pushProvider } from '../shared/pushDelivery'

const httpError = (statusCode: number) => Object.assign(new Error('Received unexpected response code'), { statusCode, body: 'provider says no' })

describe('push delivery classification', () => {
  it('maps HTTP answers of the push service to a class and keeps the status code', () => {
    expect(classifyPushError(httpError(410))).toEqual({ status: 'expired', code: 410 })
    expect(classifyPushError(httpError(404))).toEqual({ status: 'expired', code: 404 })
    expect(classifyPushError(httpError(403))).toEqual({ status: 'rejected', code: 403 })
    expect(classifyPushError(httpError(401))).toEqual({ status: 'rejected', code: 401 })
    expect(classifyPushError(httpError(429))).toEqual({ status: 'error', code: 429 })
    expect(classifyPushError(httpError(500))).toEqual({ status: 'error', code: 500 })
  })

  it('recognizes an unreachable push service', () => {
    for (const code of ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']) {
      expect(classifyPushError(Object.assign(new Error('socket'), { code }))).toEqual({ status: 'network' })
    }
  })

  it('never carries the response body or message', () => {
    const result = classifyPushError(httpError(403))
    expect(JSON.stringify(result)).not.toContain('provider says no')
    expect(classifyPushError('boom')).toEqual({ status: 'error' })
    expect(classifyPushError(null)).toEqual({ status: 'error' })
  })

  it('forgets an expired device only after the keep delay', () => {
    const now = Date.parse('2026-06-01T00:00:00Z')
    const at = (ms: number) => new Date(now - ms).toISOString()
    expect(expiredLongAgo({ at: at(EXPIRED_KEEP_MS + 1000), status: 'expired', code: 410 }, now)).toBe(true)
    expect(expiredLongAgo({ at: at(1000), status: 'expired', code: 410 }, now)).toBe(false)
    expect(expiredLongAgo({ at: at(EXPIRED_KEEP_MS + 1000), status: 'rejected', code: 403 }, now)).toBe(false)
    expect(expiredLongAgo(undefined, now)).toBe(false)
  })

  it('names the push service without exposing the endpoint', () => {
    expect(pushProvider('https://web.push.apple.com/abc')).toBe('apple')
    expect(pushProvider('https://fcm.googleapis.com/fcm/send/abc')).toBe('google')
    expect(pushProvider('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe('mozilla')
    expect(pushProvider('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe('microsoft')
    expect(pushProvider('https://push.example/abc')).toBe('other')
    expect(pushProvider('not a url')).toBe('unknown')
  })
})
