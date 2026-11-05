import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_ROUTES, coreRouteAllowed } from '../shared/coreRoutes'

// Routes of server/api/, as the allowlist writes them ('client-plugins/:id/:file').
function apiRoutes(dir = path.join(__dirname, '../server/api'), base = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return apiRoutes(path.join(dir, e.name), `${base}${e.name.replace(/^\[(\w+)\]$/, ':$1')}/`)
    const name = e.name.replace(/(\.(get|post|delete|head))?\.ts$/, '').replace(/^\[(\w+)\]$/, ':$1')
    return name.startsWith('[...') ? [] : [`${base}${name}`]
  })
}

describe('coreRouteAllowed', () => {
  it.each([
    '/api/state', '/api/state?x=1', '/api/auth/status', '/api/auth/login/options', '/api/core', '/api/core/terminals', '/api/health',
    '/api/chat', '/api/chat/image?pane=1', '/api/search?q=a', '/api/dirs?path=/', '/api/machine/add',
    '/api/machine/core', '/api/machine/core-rename', '/api/machine/core-forget', '/api/keep?pane=1',
    '/api/upload', '/api/attach', '/api/file', '/api/client-plugins', '/api/client-plugins/p1/main.js',
    '/api/dictation/key', '/api/push/subscribe',
  ])('allows %s', (p) => { expect(coreRouteAllowed(p)).toBe(true) })

  it.each([
    '/api/models', '/api/model', '/api/effort', '/api/restart', '/api/codex-update', '/api/tasks/1',
    '/api/statex', '/api/authx', '/api/machine', '/api/machine/remove', '/api/chat/other', '/api/stat', '/state',
    '/api/auth', '/api/auth/login', '/api/core/session', '/api/dictation', '/api/dictation/other', '/api/files/write',
    '/api/push', '/api/push/other', '/api/client-plugins/x', '/api/client-plugins/x/y/z', '/api/client-plugins//main.js',
  ])('refuses %s', (p) => { expect(coreRouteAllowed(p)).toBe(false) })
  it('allows the phone address and reads the version, but never the self-update', () => {
    expect(coreRouteAllowed('/api/phone')).toBe(true)
    expect(coreRouteAllowed('/api/phone', 'POST')).toBe(true)
    expect(coreRouteAllowed('/api/update?x=1')).toBe(true)
    expect(coreRouteAllowed('/api/update', 'GET')).toBe(true)
    expect(coreRouteAllowed('/api/update', 'POST')).toBe(false)
    expect(coreRouteAllowed('/api/update/status')).toBe(false)
  })
  it('answers the file browser routes', () => {
    for (const r of ['/api/files?pane=x', '/api/files/read?pane=x&path=a', '/api/files/download?pane=x']) expect(coreRouteAllowed(r)).toBe(true)
  })
  // v3 has no other backend: a route of server/api/ left out of the list is
  // refused by the guard (server/middleware/guard.ts: coreRouteAllowed(path,
  // event.method)) with 503, as Install's POST dictation/prepare once was.
  it('answers every route of server/api/, with its own method', () => {
    const methodOf = (r: string) => (/\.(post|delete)\.ts$/.exec(r)?.[1] ?? 'get').toUpperCase()
    const files = (dir: string, base = ''): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? files(path.join(dir, e.name), `${base}${e.name}/`) : e.name.startsWith('[...') ? [] : [`${base}${e.name}`])
    const refused = files(path.join(__dirname, '../server/api'))
      .map(f => ({ method: methodOf(f), url: `/api/${f.replace(/(\.(get|post|delete|head))?\.ts$/, '').replace(/\[\w+\]/g, 'x')}` }))
      .filter(r => !coreRouteAllowed(r.url, r.method))
    expect(refused).toEqual([])
    expect(coreRouteAllowed('/api/dictation/prepare', 'POST')).toBe(true)
  })
  it('lists only routes that exist', () => {
    const existing = new Set(apiRoutes())
    for (const r of CORE_ROUTES) expect(existing, r).toContain(r.replace(/^GET /, ''))
  })
})
