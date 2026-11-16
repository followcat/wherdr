import { describe, expect, it } from 'vitest'
import { applySettingsPatch, type SettingsMap, type SettingsPatch } from '../shared/settings'
import { createSettingsSync, type LocalStore } from '../app/utils/syncedSettings'

// One fake server (its map), and devices each with their own localStorage.
function fakeServer(initial: SettingsMap = {}) {
  const server = { map: { ...initial } as SettingsMap, posts: [] as { patch: SettingsPatch, migrate: boolean }[], down: false, devices: [] as ReturnType<typeof device>[] }
  const transport = {
    get: async () => { if (server.down) throw new Error('offline'); return { ...server.map } },
    post: async (patch: SettingsPatch, migrate: boolean) => {
      if (server.down) throw new Error('offline')
      server.posts.push({ patch, migrate })
      const { next, changed } = applySettingsPatch(server.map, patch, migrate)
      server.map = next
      // The /ws/events broadcast, to every device.
      if (Object.keys(changed).length) for (const d of server.devices) d.sync.receive(changed)
      return { ...server.map }
    },
  }
  function device(stored: Record<string, string> = {}) {
    const data = new Map(Object.entries(stored))
    const local: LocalStore = { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, remove: (k) => { data.delete(k) } }
    const sync = createSettingsSync({ local, transport, delay: 0 })
    const d = { data, sync }
    server.devices.push(d)
    return d
  }
  return { server, device }
}

describe('settings kept on the server', () => {
  it('migration: an empty server takes this browser’s values, device-only keys excluded', async () => {
    const { server, device } = fakeServer()
    const a = device({ theme: 'nord', showCounters: '1', contentWidth: 'wide', listWidth: '320' })
    await a.sync.load()
    expect(server.posts).toEqual([{ patch: { theme: 'nord', showCounters: '1' }, migrate: true }])
    expect(server.map).toEqual({ theme: 'nord', showCounters: '1' })
    expect(a.data.get('contentWidth')).toBe('wide')
  })

  it('a second device merges in what the server lacks, and takes the server’s values for the rest', async () => {
    const groups = JSON.stringify([{ id: '*group:home', name: 'Home', machines: ['laptop'] }])
    const { server, device } = fakeServer()
    const phone = device({ theme: 'nord', typewriterSpeed: 'medium' })
    await phone.sync.load()
    const ipad = device({ theme: 'paper', typewriterSpeed: 'fast', machineGroups: groups, showCounters: '1', collapsedMachines: '["laptop"]' })
    await ipad.sync.load()
    expect(server.map).toEqual({ theme: 'nord', typewriterSpeed: 'medium', machineGroups: groups, showCounters: '1', collapsedMachines: '["laptop"]' })
    expect(ipad.data.get('machineGroups')).toBe(groups)
    expect(ipad.data.get('theme')).toBe('nord')
    // The phone gets the iPad's groups at once (/ws/events).
    expect(phone.data.get('machineGroups')).toBe(groups)
    // Each device merges only once.
    await ipad.sync.load()
    expect(server.posts.filter(p => p.migrate)).toHaveLength(2)
  })

  it('afterwards the server is the reference: a migrated device takes its values', async () => {
    const { server, device } = fakeServer({ theme: 'nord', homeGrouping: 'state' })
    const b = device({ theme: 'paper', showCounters: '1', syncedSettingsMigrated: '1' })
    const applied: (string | null)[] = []
    b.sync.bind('theme', raw => applied.push(raw))
    await b.sync.load()
    expect(server.posts).toEqual([])
    expect(b.data.get('theme')).toBe('nord')
    expect(b.data.get('homeGrouping')).toBe('state')
    // A key the server lacks goes back to its default.
    expect(b.data.has('showCounters')).toBe(false)
    expect(applied).toEqual(['nord'])
  })

  it('two devices: a change on one applies on the other, and is not sent back', async () => {
    const { server, device } = fakeServer({ theme: 'nord' })
    const a = device()
    const b = device()
    await a.sync.load()
    await b.sync.load()
    const seenOnB: (string | null)[] = []
    b.sync.bind('homeGrouping', raw => seenOnB.push(raw))
    a.sync.write('homeGrouping', 'state')
    await a.sync.flush()
    expect(seenOnB).toEqual(['state'])
    expect(b.data.get('homeGrouping')).toBe('state')
    // Only device A posted.
    expect(server.posts).toEqual([{ patch: { homeGrouping: 'state' }, migrate: false }])
  })

  it('last write wins, setting by setting', async () => {
    const { server, device } = fakeServer({ theme: 'nord' })
    const a = device()
    const b = device()
    await Promise.all([a.sync.load(), b.sync.load()])
    a.sync.write('theme', 'paper')
    a.sync.write('showCounters', '1')
    b.sync.write('theme', 'mono')
    await a.sync.flush()
    await b.sync.flush()
    expect(server.map).toEqual({ theme: 'mono', showCounters: '1' })
    expect(a.data.get('theme')).toBe('mono')
    expect(b.data.get('showCounters')).toBe('1')
  })

  it('offline: the change stays local and goes out on reconnection', async () => {
    const { server, device } = fakeServer({ theme: 'nord' })
    const a = device()
    await a.sync.load()
    server.down = true
    a.sync.write('theme', 'paper')
    expect(await a.sync.flush()).toBe(false)
    expect(a.data.get('theme')).toBe('paper')
    expect(a.sync.pendingKeys).toEqual(['theme'])
    server.down = false
    await a.sync.load()
    expect(server.map.theme).toBe('paper')
    expect(a.data.get('theme')).toBe('paper')
    expect(a.sync.pendingKeys).toEqual([])
  })

  it('a change not yet sent is not overwritten by an older server value', async () => {
    const { device } = fakeServer({ theme: 'nord' })
    const a = device({ theme: 'nord' })
    a.sync.write('theme', 'paper')
    a.sync.receive({ theme: 'mono' })
    expect(a.data.get('theme')).toBe('paper')
  })

  it('a key outside the synced list is never applied from the server', async () => {
    const { device } = fakeServer()
    const a = device({ contentWidth: 'wide' })
    a.sync.receive({ contentWidth: 'narrow', theme: 'nord' } as SettingsPatch)
    expect(a.data.get('contentWidth')).toBe('wide')
    expect(a.data.get('theme')).toBe('nord')
  })
})

describe('changes left by the previous page', () => {
  it('a change made just before a reload goes out on the next load, and wins', async () => {
    const { server, device } = fakeServer({ theme: 'nord' })
    const a = device({ theme: 'nord' })
    await a.sync.load()
    server.down = true
    a.sync.write('homeGrouping', 'state')
    await a.sync.flush()
    server.down = false
    // The page reloads: a new store on the same localStorage.
    const reloaded = device(Object.fromEntries(a.data))
    await reloaded.sync.load()
    expect(server.map).toEqual({ theme: 'nord', homeGrouping: 'state' })
    expect(reloaded.data.get('homeGrouping')).toBe('state')
    expect(reloaded.data.has('syncedSettingsPending')).toBe(false)
  })

  it('a migration still sends every value when a change was pending', async () => {
    const { server, device } = fakeServer()
    const a = device({ showCounters: '1', syncedSettingsPending: JSON.stringify({ theme: 'paper' }), theme: 'paper' })
    await a.sync.load()
    expect(server.map).toEqual({ showCounters: '1', theme: 'paper' })
  })
})
