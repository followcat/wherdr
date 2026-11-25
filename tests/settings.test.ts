import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applySettingsPatch, cleanSettingsPatch, readHcSockets, SETTING_MAX } from '../shared/settings'
import { coreRuntimeDir, filterAllowedHcSockets, hcSockets, loadSettings, onSettingsChange, patchSettings, prepareSettingsPatch, readSettings } from '../server/utils/settings'
import { chatFilesPolicy } from '../server/utils/chatFiles'

describe('settings patch', () => {
  it('keeps known keys with text or null, drops the rest', () => {
    expect(cleanSettingsPatch({ theme: 'nord', showCounters: null, token: 'x', fontSize: '14', showShells: 1 })).toEqual({ theme: 'nord', showCounters: null })
    expect(cleanSettingsPatch({ theme: 'x'.repeat(SETTING_MAX + 1) })).toBeNull()
    expect(cleanSettingsPatch([])).toBeNull()
    expect(cleanSettingsPatch('theme')).toBeNull()
  })
  it('reports only what changed; null forgets a key', () => {
    const { next, changed } = applySettingsPatch({ theme: 'nord', showCounters: '1' }, { theme: 'nord', showCounters: null, homeGrouping: 'state' })
    expect(next).toEqual({ theme: 'nord', homeGrouping: 'state' })
    expect(changed).toEqual({ showCounters: null, homeGrouping: 'state' })
  })
  it('a migration never replaces a key the server already has', () => {
    const { next, changed } = applySettingsPatch({ theme: 'nord' }, { theme: 'paper', showCounters: '1' }, true)
    expect(next).toEqual({ theme: 'nord', showCounters: '1' })
    expect(changed).toEqual({ showCounters: '1' })
  })
})

describe('settings file', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wherdr-settings-'))
    file = path.join(dir, 'data', 'settings.json')
  })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('reads nothing from a missing or broken file', async () => {
    expect(await readSettings(file)).toEqual({})
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{not json')
    expect(await readSettings(file)).toEqual({})
  })
  it('never writes over an unreadable or damaged file; a missing one starts empty', async () => {
    await patchSettings({ theme: 'nord' }, { file })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).settings).toEqual({ theme: 'nord' })
    await fs.writeFile(file, '{not json')
    await expect(patchSettings({ showCounters: '1' }, { file })).rejects.toMatchObject({ code: 'settings_damaged' })
    expect(await fs.readFile(file, 'utf8')).toBe('{not json')
    await fs.rm(file)
    await fs.mkdir(file) // reading a folder fails with EISDIR, like EIO or EACCES would
    await expect(patchSettings({ theme: 'paper' }, { file })).rejects.toMatchObject({ code: 'settings_unreadable' })
    expect((await fs.stat(file)).isDirectory()).toBe(true)
    expect(await readSettings(file)).toEqual({})
    // GET /api/settings and every decision read through loadSettings: an error, never {}.
    await expect(loadSettings(file)).rejects.toMatchObject({ code: 'settings_unreadable' })
    expect(await chatFilesPolicy(file)).toEqual({ level: 'home', protected: false })
  })
  it('writes atomically, private, and leaves no temporary file', async () => {
    await patchSettings({ theme: 'nord' }, { file })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ v: 1, settings: { theme: 'nord' } })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(path.dirname(file))).toEqual(['settings.json'])
  })
  it('keeps both of two simultaneous writes; the last one wins for the same key', async () => {
    await Promise.all([
      patchSettings({ theme: 'nord', showCounters: '1' }, { file }),
      patchSettings({ homeGrouping: 'state', theme: 'paper' }, { file }),
    ])
    expect(await readSettings(file)).toEqual({ theme: 'paper', showCounters: '1', homeGrouping: 'state' })
  })
  it('tells the listeners what changed, and nothing for a no-op', async () => {
    const seen: unknown[] = []
    const off = onSettingsChange(c => seen.push(c))
    await patchSettings({ theme: 'nord' }, { file })
    await patchSettings({ theme: 'nord' }, { file })
    await patchSettings({ theme: 'paper', showCounters: '1' }, { file, onlyMissing: true })
    off()
    expect(seen).toEqual([{ theme: 'nord' }, { showCounters: '1' }])
  })
  it('drops removed settings left in the file (compact list, Show terminals)', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ v: 1, settings: { compactList: '1', compactListV2: '1', showShells: '0', theme: 'nord' } }))
    expect(await readSettings(file)).toEqual({ theme: 'nord' })
    await patchSettings({ showCounters: '1' }, { file })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).settings).toEqual({ theme: 'nord', showCounters: '1' })
  })
  it('stores and validates hcSockets fail-closed against the user herdr-core runtime directory', async () => {
    expect(readHcSockets(JSON.stringify([' /run/a.sock ', '', '/run/a.sock', '/run/b.sock']))).toEqual(['/run/a.sock', '/run/b.sock'])
    expect(readHcSockets(['/run/x.sock', 42, '/run/y.sock'])).toEqual(['/run/x.sock', '/run/y.sock'])
    expect(cleanSettingsPatch({ hcSockets: ['/run/backlot.sock'] })).toEqual({ hcSockets: JSON.stringify(['/run/backlot.sock']) })

    const rtDir = path.join(dir, 'runtime', 'herdr-core')
    const subDir = path.join(rtDir, 'nested')
    const outsideDir = path.join(dir, 'outside')
    await fs.mkdir(subDir, { recursive: true })
    await fs.mkdir(outsideDir, { recursive: true })

    const servers: net.Server[] = []
    const listen = async (sock: string) => {
      const srv = net.createServer()
      servers.push(srv)
      await new Promise<void>(resolve => srv.listen(sock, resolve))
      return sock
    }
    try {
      const primarySock = await listen(path.join(rtDir, 'default.sock'))
      const validSock = await listen(path.join(rtDir, 'backlot.sock'))
      const outsideSock = await listen(path.join(outsideDir, 'evil.sock'))
      const nestedSock = await listen(path.join(subDir, 'nested.sock'))
      const symlinkOut = path.join(rtDir, 'escape.sock')
      await fs.symlink(outsideSock, symlinkOut)
      const regularFile = path.join(rtDir, 'not-a-socket.sock')
      await fs.writeFile(regularFile, 'SECRET_FILE_CONTENTS')
      const missingSock = path.join(rtDir, 'missing.sock')

      const realRtDir = await fs.realpath(rtDir)
      const realValidSock = await fs.realpath(validSock)
      expect(coreRuntimeDir({ primary: primarySock })).toBe(realRtDir)
      expect(coreRuntimeDir({ primary: '', env: { XDG_RUNTIME_DIR: path.join(dir, 'runtime') } as NodeJS.ProcessEnv })).toBe(realRtDir)

      const logs: string[] = []
      const allowed = await filterAllowedHcSockets(
        [validSock, outsideSock, nestedSock, symlinkOut, regularFile, missingSock],
        { primary: primarySock, log: msg => logs.push(msg) },
      )
      expect(allowed).toEqual([realValidSock])
      expect(logs).toHaveLength(5)
      for (const line of logs) {
        expect(line).toMatch(/^hcSockets: dropped entry \(/)
        expect(line).not.toContain('SECRET_FILE_CONTENTS')
        expect(line).not.toContain(dir)
      }

      // Wrong uid fails closed.
      const wrongUidLogs: string[] = []
      const expectedUid = (process.getuid?.() ?? 1000) + 1
      expect(await filterAllowedHcSockets([validSock], { primary: primarySock, uid: expectedUid, log: msg => wrongUidLogs.push(msg) })).toEqual([])
      expect(wrongUidLogs[0]).toContain('not owned')

      // prepareSettingsPatch + hcSockets enforce validation on write and read.
      const prepared = await prepareSettingsPatch(
        { hcSockets: [validSock, outsideSock, regularFile] },
        { primary: primarySock, log: () => {} },
      )
      expect(prepared).toEqual({ hcSockets: JSON.stringify([realValidSock]) })
      await patchSettings({ hcSockets: JSON.stringify([validSock, outsideSock, symlinkOut, regularFile]) }, { file })
      expect(await hcSockets(file, { primary: primarySock, log: () => {} })).toEqual([realValidSock])

      await patchSettings({ hcSockets: null }, { file })
      expect(await hcSockets(file, { primary: primarySock, log: () => {} })).toEqual([])
    } finally {
      for (const s of servers) await new Promise<void>(resolve => s.close(() => resolve()))
    }
  })
})
