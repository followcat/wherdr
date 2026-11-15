import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applySettingsPatch, cleanSettingsPatch, SETTING_MAX } from '../shared/settings'
import { onSettingsChange, patchSettings, readSettings } from '../server/utils/settings'

describe('settings patch', () => {
  it('keeps known keys with text or null, drops the rest', () => {
    expect(cleanSettingsPatch({ theme: 'nord', compactListV2: null, token: 'x', fontSize: '14', showShells: 1 })).toEqual({ theme: 'nord', compactListV2: null })
    expect(cleanSettingsPatch({ theme: 'x'.repeat(SETTING_MAX + 1) })).toBeNull()
    expect(cleanSettingsPatch([])).toBeNull()
    expect(cleanSettingsPatch('theme')).toBeNull()
  })
  it('reports only what changed; null forgets a key', () => {
    const { next, changed } = applySettingsPatch({ theme: 'nord', compactListV2: '1' }, { theme: 'nord', compactListV2: null, homeGrouping: 'state' })
    expect(next).toEqual({ theme: 'nord', homeGrouping: 'state' })
    expect(changed).toEqual({ compactListV2: null, homeGrouping: 'state' })
  })
  it('a migration never replaces a key the server already has', () => {
    const { next, changed } = applySettingsPatch({ theme: 'nord' }, { theme: 'paper', compactListV2: '1' }, true)
    expect(next).toEqual({ theme: 'nord', compactListV2: '1' })
    expect(changed).toEqual({ compactListV2: '1' })
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
    await expect(patchSettings({ compactListV2: '1' }, { file })).rejects.toMatchObject({ code: 'settings_damaged' })
    expect(await fs.readFile(file, 'utf8')).toBe('{not json')
    await fs.rm(file)
    await fs.mkdir(file) // reading a folder fails with EISDIR, like EIO or EACCES would
    await expect(patchSettings({ theme: 'paper' }, { file })).rejects.toMatchObject({ code: 'settings_unreadable' })
    expect((await fs.stat(file)).isDirectory()).toBe(true)
    expect(await readSettings(file)).toEqual({})
  })
  it('writes atomically, private, and leaves no temporary file', async () => {
    await patchSettings({ theme: 'nord' }, { file })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ v: 1, settings: { theme: 'nord' } })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(path.dirname(file))).toEqual(['settings.json'])
  })
  it('keeps both of two simultaneous writes; the last one wins for the same key', async () => {
    await Promise.all([
      patchSettings({ theme: 'nord', compactListV2: '1' }, { file }),
      patchSettings({ homeGrouping: 'state', theme: 'paper' }, { file }),
    ])
    expect(await readSettings(file)).toEqual({ theme: 'paper', compactListV2: '1', homeGrouping: 'state' })
  })
  it('tells the listeners what changed, and nothing for a no-op', async () => {
    const seen: unknown[] = []
    const off = onSettingsChange(c => seen.push(c))
    await patchSettings({ theme: 'nord' }, { file })
    await patchSettings({ theme: 'nord' }, { file })
    await patchSettings({ theme: 'paper', compactListV2: '1' }, { file, onlyMissing: true })
    off()
    expect(seen).toEqual([{ theme: 'nord' }, { compactListV2: '1' }])
  })
  it('drops the 1.x compact list left in the file (2.0 resets it to normal once)', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ v: 1, settings: { compactList: '1', theme: 'nord' } }))
    expect(await readSettings(file)).toEqual({ theme: 'nord' })
    await patchSettings({ compactListV2: '1' }, { file })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).settings).toEqual({ theme: 'nord', compactListV2: '1' })
  })
})
