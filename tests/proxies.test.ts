// Saved proxies: the entry's validation and mask, the per-machine offer, the
// env a launch gets (never in the command line), the server file in DATA_DIR
// (masked reads, a ••• url keeps the stored password) and coreCreate passing
// it all to terminal.run's env.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanProxyEntry, maskedProxyUrl, proxyEnv, proxyOfferedOn, PROXY_MASK, type ProxyEntry } from '../shared/proxies'
import { proxiesView, proxyEnvFor, readProxies, rememberProxyChoice, saveProxies } from '../server/utils/proxies'
import { coreCreate, type CoreAdminDeps } from '../server/utils/coreCreate'
import type { MachineInfo, Pane } from '../shared/types'

const tmp = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'proxies-')), 'proxies.json')
const entry = (id: string, over: Partial<ProxyEntry> = {}): ProxyEntry => ({ id, name: id, url: 'http://alice:secret@proxy.example:3128', ...over })

describe('cleanProxyEntry', () => {
  it('takes http(s) and socks5 urls, with or without credentials', () => {
    for (const url of ['http://proxy.example:3128', 'https://alice:secret@proxy.example:3128', 'socks5://127.0.0.1:7890'])
      expect(cleanProxyEntry({ name: 'n', url })).toMatchObject({ name: 'n', url })
  })
  it('refuses other schemes, no host, a path, a query or a fragment', () => {
    for (const url of ['ftp://proxy.example', 'http://', 'http://proxy.example/x', 'http://proxy.example?x=1', 'http://proxy.example#x', 'not a url', ''])
      expect(cleanProxyEntry({ name: 'n', url })).toBeNull()
  })
  it('refuses a missing or too-long name and a malformed id', () => {
    expect(cleanProxyEntry({ url: 'http://proxy.example' })).toBeNull()
    expect(cleanProxyEntry({ name: '', url: 'http://proxy.example' })).toBeNull()
    expect(cleanProxyEntry({ name: 'x'.repeat(61), url: 'http://proxy.example' })).toBeNull()
    expect(cleanProxyEntry({ name: 'n', url: 'http://proxy.example', id: 'BAD ID!' })).not.toMatchObject({ id: 'BAD ID!' })
  })
  it('refuses the ••• mask as a new password, keeps noProxy and machines clean', () => {
    expect(cleanProxyEntry({ name: 'n', url: `http://alice:${PROXY_MASK}@proxy.example:3128` })).toBeNull()
    expect(cleanProxyEntry({ name: 'n', url: `http://alice:${PROXY_MASK}@proxy.example:3128`, id: 'abc123' })).toMatchObject({ id: 'abc123' })
    const e = cleanProxyEntry({ name: ' n ', url: 'http://proxy.example', noProxy: ' localhost,127.0.0.1 ', machines: ['vps', 'vps', 5, ''] })
    expect(e).toMatchObject({ name: 'n', noProxy: 'localhost,127.0.0.1', machines: ['vps', ''] })
  })
})

describe('maskedProxyUrl', () => {
  it('hides only the password', () => {
    expect(maskedProxyUrl('http://alice:secret@proxy.example:3128')).toBe(`http://alice:${PROXY_MASK}@proxy.example:3128`)
    expect(maskedProxyUrl('socks5://bob:shh@[::1]:1080')).toBe(`socks5://bob:${PROXY_MASK}@[::1]:1080`)
    expect(maskedProxyUrl('http://alice@proxy.example:3128')).toBe('http://alice@proxy.example:3128')
    expect(maskedProxyUrl('http://proxy.example:3128')).toBe('http://proxy.example:3128')
    expect(maskedProxyUrl('junk')).toBe('junk')
  })
})

describe('proxyOfferedOn and proxyEnv', () => {
  it('offers an entry on the machines it names, everywhere by default', () => {
    const open = entry('a')
    expect(proxyOfferedOn(open, '')).toBe(true)
    expect(proxyOfferedOn(open, 'vps')).toBe(true)
    const some = entry('b', { machines: ['vps'] })
    expect(proxyOfferedOn(some, 'vps')).toBe(true)
    expect(proxyOfferedOn(some, '')).toBe(false)
    expect(proxyOfferedOn(some, 'other')).toBe(false)
  })
  it('maps an entry to the proxy env, all cases', () => {
    const http = proxyEnv({ ...entry('a'), noProxy: 'localhost,.internal' })
    expect(http).toEqual({
      HTTPS_PROXY: 'http://alice:secret@proxy.example:3128', https_proxy: 'http://alice:secret@proxy.example:3128',
      HTTP_PROXY: 'http://alice:secret@proxy.example:3128', http_proxy: 'http://alice:secret@proxy.example:3128',
      NO_PROXY: 'localhost,.internal', no_proxy: 'localhost,.internal',
    })
    const socks = proxyEnv(entry('s', { url: 'socks5://127.0.0.1:7890' }))
    expect(socks).toEqual({
      HTTPS_PROXY: 'socks5://127.0.0.1:7890', https_proxy: 'socks5://127.0.0.1:7890',
      HTTP_PROXY: 'socks5://127.0.0.1:7890', http_proxy: 'socks5://127.0.0.1:7890',
      ALL_PROXY: 'socks5://127.0.0.1:7890', all_proxy: 'socks5://127.0.0.1:7890',
    })
    expect('NO_PROXY' in proxyEnv(entry('n'))).toBe(false)
  })
})

describe('server store', () => {
  it('masks passwords in the view but keeps them on disk', async () => {
    const file = await tmp()
    const saved = await saveProxies([{ name: 'office', url: 'http://alice:secret@proxy.example:3128' }], file)
    expect(saved).toEqual([expect.objectContaining({ name: 'office', url: `http://alice:${PROXY_MASK}@proxy.example:3128` })])
    const disk = await readProxies(file)
    expect(disk.proxies[0]!.url).toBe('http://alice:secret@proxy.example:3128')
    const view = await proxiesView(file)
    expect(view.proxies[0]!.url).not.toContain('secret')
    expect(JSON.stringify(view)).not.toContain('secret')
  })
  it('keeps the stored password when a ••• url comes back, drops an unknown mask', async () => {
    const file = await tmp()
    const [a] = await saveProxies([{ name: 'office', url: 'http://alice:secret@proxy.example:3128' }], file)
    await saveProxies([{ id: a!.id, name: 'office', url: `http://alice:${PROXY_MASK}@proxy.example:8080` }], file)
    const disk = await readProxies(file)
    expect(disk.proxies[0]!.url).toBe('http://alice:secret@proxy.example:8080')
    // A mask on an unknown id is a refusal, never a stored •••.
    await expect(saveProxies([{ name: 'x', url: `http://u:${PROXY_MASK}@h:1` }], file)).rejects.toMatchObject({ code: 'bad_proxy' })
    await expect(saveProxies([{ id: 'zzzz99', name: 'x', url: `http://u:${PROXY_MASK}@h:1` }], file)).rejects.toMatchObject({ code: 'bad_proxy' })
    expect((await readProxies(file)).proxies).toHaveLength(1)
    expect((await readProxies(file)).proxies[0]!.url).toBe('http://alice:secret@proxy.example:8080')
  })
  it('reorders and deletes, and forgets a deleted remembered choice', async () => {
    const file = await tmp()
    const [a, b] = await saveProxies([{ name: 'a', url: 'http://proxy.example:1' }, { name: 'b', url: 'http://proxy.example:2' }], file)
    await rememberProxyChoice('', a!.id, file)
    expect((await readProxies(file)).last['']).toBe(a!.id)
    await saveProxies([{ id: b!.id, name: 'b', url: 'http://proxy.example:2' }], file)
    expect((await readProxies(file)).proxies.map(p => p.name)).toEqual(['b'])
    expect((await readProxies(file)).last['']).toBeUndefined()
    await expect(saveProxies('nope', file)).rejects.toMatchObject({ code: 'bad_proxy' })
    await expect(saveProxies([{ name: 'ok', url: 'http://x' }, { name: 'bad', url: 'ftp://x' }], file)).rejects.toMatchObject({ code: 'bad_proxy' })
  })
  it('remembers a choice per machine and refuses ids that name nothing', async () => {
    const file = await tmp()
    const [a] = await saveProxies([{ name: 'a', url: 'http://proxy.example:1' }], file)
    await rememberProxyChoice('', a!.id, file)
    await rememberProxyChoice('', 'nosuch0', file)
    await rememberProxyChoice('vps', 'nosuch0', file)
    expect((await readProxies(file)).last).toEqual({ '': a!.id })
  })
  it('resolves the env from an explicit or remembered choice, only when offered there', async () => {
    const file = await tmp()
    const [a, b] = await saveProxies([
      { name: 'a', url: 'http://alice:secret@proxy.example:3128' },
      { name: 'b', url: 'socks5://127.0.0.1:7890', machines: ['vps'] },
    ], file)
    const store = await readProxies(file)
    expect(proxyEnvFor(store, '', a!.id).HTTPS_PROXY).toBe('http://alice:secret@proxy.example:3128')
    expect(proxyEnvFor(store, '', b!.id)).toEqual({}) // not offered on this machine
    expect(proxyEnvFor(store, 'vps', b!.id).ALL_PROXY).toBe('socks5://127.0.0.1:7890')
    expect(proxyEnvFor(store, '', '')).toEqual({})
    expect(proxyEnvFor(store, '', 'nosuch0')).toEqual({})
    await rememberProxyChoice('', a!.id, file)
    expect(proxyEnvFor(await readProxies(file), '', undefined).http_proxy).toBe('http://alice:secret@proxy.example:3128')
  })
})

describe('coreCreate', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  const machines: MachineInfo[] = [
    { key: '', label: 'Local', local: true, status: 'online', error: null },
    { key: '7667', label: 'vps', local: false, status: 'online', error: null },
  ]
  function setup(env: Record<string, string>, remembered: string[] = []) {
    const calls: [string, any][] = []
    const deps: CoreAdminDeps = {
      call: async (method, params) => {
        calls.push([method, params])
        if (method === 'machine.exec') {
          const script: string = params.argv[2]
          if (script.startsWith('printf')) return { code: 0, stdout: b64('/home/u') }
          if (script.includes('command -v')) return { code: 0, stdout: b64('claude\n') }
          return { code: 0, stdout: '' }
        }
        if (method === 'terminal.run') return { address: 't3' }
        return {} as never
      },
      machines: () => machines,
      panes: () => [{ id: 'w2:p2', workspace: 'w2', coreAddress: 't3' } as Pane],
      workspaces: () => [],
      settle: async () => {},
      recent: async () => [],
      remember: async () => {},
      launchWatchMs: 0,
      proxyEnv: async () => env,
      rememberProxy: async (key, choice) => { remembered.push(`${key}=${choice}`) },
    }
    return { deps, calls, remembered }
  }

  it('sends the proxy as env on terminal.run, never in the line', async () => {
    const t = setup({ HTTPS_PROXY: 'http://alice:secret@proxy.example:3128', https_proxy: 'http://alice:secret@proxy.example:3128', HTTP_PROXY: 'http://alice:secret@proxy.example:3128', http_proxy: 'http://alice:secret@proxy.example:3128' })
    await coreCreate(t.deps, { kind: 'claude', cwd: '/home/u', proxy: 'px1' })
    const params = t.calls.find(c => c[0] === 'terminal.run')![1]
    expect(params.env.https_proxy).toBe('http://alice:secret@proxy.example:3128')
    expect(params.line).not.toContain('proxy.example')
    expect(params.line).not.toContain('secret')
    expect(JSON.stringify(params.labels)).not.toContain('proxy.example')
    expect(t.remembered).toEqual(['=px1'])
  })
  it('passes the env on a remote machine too, and remembers an explicit None', async () => {
    const t = setup({ HTTP_PROXY: 'http://proxy.example:3128' })
    t.deps.panes = () => [{ id: 'w1:p1', workspace: 'w1', coreAddress: 'vps/t7' } as Pane]
    t.deps.call = (async (method: string, params: any) => {
      t.calls.push([method, params])
      if (method === 'machine.exec') {
        const script: string = params.argv[2]
        if (script.startsWith('printf')) return { code: 0, stdout: b64('/home/u') }
        if (script.includes('command -v')) return { code: 0, stdout: b64('claude\n') }
        return { code: 0, stdout: '' }
      }
      if (method === 'terminal.run') return { address: 'vps/t7' }
      return {}
    }) as never
    await coreCreate(t.deps, { kind: 'shell', machine: '7667', cwd: '/home/u', proxy: '' })
    const params = t.calls.find(c => c[0] === 'terminal.run')![1]
    expect(params.on).toBe('vps')
    expect(params.env).toEqual({ HTTP_PROXY: 'http://proxy.example:3128' })
    expect(t.remembered).toEqual(['7667='])
  })
  it('sends no env and remembers nothing without a picker choice', async () => {
    const t = setup({})
    await coreCreate(t.deps, { kind: 'shell', cwd: '/home/u' })
    const params = t.calls.find(c => c[0] === 'terminal.run')![1]
    expect(params.env).toBeUndefined()
    expect(t.remembered).toEqual([])
  })
})
