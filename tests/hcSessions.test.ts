import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listLocalHcSessions } from '../server/utils/hcSessions'

describe('local hc session listing', () => {
  let dir: string
  let rtDir: string
  let settingsFile: string
  let servers: net.Server[] = []

  const listen = async (sock: string) => {
    const srv = net.createServer()
    servers.push(srv)
    await new Promise<void>(resolve => srv.listen(sock, resolve))
    return fs.realpath(sock)
  }
  const writeSettings = async (sockets: string[]) => {
    await fs.mkdir(path.dirname(settingsFile), { recursive: true })
    await fs.writeFile(settingsFile, JSON.stringify({ v: 1, settings: { hcSockets: JSON.stringify(sockets) } }))
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wherdr-hc-sessions-'))
    rtDir = path.join(dir, 'runtime', 'herdr-core')
    settingsFile = path.join(dir, 'data', 'settings.json')
    servers = []
    await fs.mkdir(rtDir, { recursive: true })
  })
  afterEach(async () => {
    await Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => resolve()))))
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('lists only user sockets directly in the runtime directory, without holders or sockets already in use', async () => {
    const primary = await listen(path.join(rtDir, 'default.sock'))
    const settingsSock = await listen(path.join(rtDir, 'backlot.sock'))
    const freeSock = await listen(path.join(rtDir, 'scratch.sock'))
    await listen(path.join(rtDir, 'default.holder.sock'))
    await listen(path.join(rtDir, 'holder-backlot.sock'))
    await fs.mkdir(path.join(rtDir, 'nested'))
    await listen(path.join(rtDir, 'nested', 'nested.sock'))
    const outside = path.join(dir, 'outside.sock')
    await listen(outside)
    await fs.symlink(outside, path.join(rtDir, 'escape.sock'))
    await fs.writeFile(path.join(rtDir, 'regular.sock'), 'not a socket')
    await writeSettings([settingsSock])

    const out = await listLocalHcSessions({
      env: { HC_SOCKET: primary } as NodeJS.ProcessEnv,
      settingsFile,
      log: () => {},
    })
    expect(out.directory).toBe(await fs.realpath(rtDir))
    expect(out.primary).toBe(primary)
    expect(out.settingsSockets).toEqual([settingsSock])
    expect(out.available).toEqual([{ path: freeSock, name: 'scratch' }])
    expect(out.available.map(s => s.path)).not.toContain(primary)
    expect(out.available.map(s => s.path)).not.toContain(settingsSock)
    expect(out.available.some(s => s.name.includes('holder'))).toBe(false)
    expect(out.available.some(s => s.path.includes('nested'))).toBe(false)
    expect(out.available.some(s => s.path === outside)).toBe(false)
  })

  it('reports env and settings sockets separately and excludes both from the additions', async () => {
    const primary = await listen(path.join(rtDir, 'default.sock'))
    const envSock = await listen(path.join(rtDir, 'env.sock'))
    const settingsSock = await listen(path.join(rtDir, 'settings.sock'))
    const freeSock = await listen(path.join(rtDir, 'free.sock'))
    await writeSettings([settingsSock])

    const out = await listLocalHcSessions({
      env: { HC_SOCKET: primary, HC_SOCKETS: `${envSock},${primary}` } as NodeJS.ProcessEnv,
      settingsFile,
      log: () => {},
    })
    expect(out.envSockets).toEqual([envSock])
    expect(out.settingsSockets).toEqual([settingsSock])
    expect(out.available).toEqual([{ path: freeSock, name: 'free' }])
  })
})
