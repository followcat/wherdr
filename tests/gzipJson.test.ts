import { describe, expect, it, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { GZIP_MIN, jsonBody } from '../server/utils/gzipJson'

describe('large JSON answers, gzipped', () => {
  const big = { items: Array.from({ length: 400 }, (_, i) => ({ role: 'assistant', text: `reply ${i}` })) }
  it('gzips a large object for a browser that takes it, and it reads back the same', () => {
    const r = jsonBody('gzip, deflate, br', big)
    expect(r?.gzip).toBe(true)
    expect(r!.body.length).toBeLessThan(JSON.stringify(big).length / 4)
    expect(JSON.parse(gunzipSync(r!.body as Buffer).toString('utf8'))).toEqual(big)
  })
  it('sends a small answer as the JSON text it built, once', () => {
    const json = vi.spyOn(JSON, 'stringify')
    try {
      expect(jsonBody('gzip', { ok: true })).toEqual({ gzip: false, body: '{"ok":true}' })
      expect(json).toHaveBeenCalledTimes(1)
    } finally { json.mockRestore() }
  })
  it('leaves other encodings and anything but plain JSON to H3', () => {
    expect(jsonBody('br', big)).toBeNull()
    expect(jsonBody(undefined, big)).toBeNull()
    expect(jsonBody('gzip', Buffer.alloc(GZIP_MIN * 2))).toBeNull()
    expect(jsonBody('gzip', 'x'.repeat(GZIP_MIN * 2))).toBeNull()
    expect(jsonBody('gzip', new Map([['a', 1]]))).toBeNull()
    expect(jsonBody('gzip', Array.from({ length: 2000 }, (_, i) => i))?.gzip).toBe(true)
  })
})
