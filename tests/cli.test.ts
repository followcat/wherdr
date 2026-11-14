import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Socket } from 'node:net'
import { HELP, context, coreRows, dictation, needCore, openAddress, panel, remember, serviceSpec } from '../bin/lib/commands.mjs'
import { removeLegacySkill } from '../bin/lib/skill.mjs'
import * as dictationFiles from '../scripts/fetch-dictation-files.mjs'
import { SESSION_IGNORED, parseArgs, parseEnvFile, portTaken, serverEnv } from '../bin/lib/core.mjs'
import fixture from './fixtures/core-0.1.16.json'
import { runtimeCandidates, temporaryInstall } from '../bin/lib/runtime.mjs'
import { launchdPlist, systemdUnit } from '../bin/lib/service.mjs'

describe('wherdr command line', () => {
  it('runs in the foreground without a command', () => {
    expect(parseArgs([])).toEqual({ command: 'run' })
    expect(parseArgs(['--port', '7690'])).toEqual({ command: 'run', port: '7690' })
  })

  it('reads commands, --name value and --name=value', () => {
    expect(parseArgs(['start', '--port', '7690', '--host=0.0.0.0', '--data-dir', '/srv/w', '--hc-socket', '/run/hc.sock']))
      .toEqual({ command: 'start', port: '7690', host: '0.0.0.0', dataDir: '/srv/w', hcSocket: '/run/hc.sock' })
    expect(parseArgs(['--hc-socket=~/hc.sock']).hcSocket).toBe('~/hc.sock')
    expect(parseArgs(['logs', '-f', '-n', '20'])).toEqual({ command: 'logs', follow: true, lines: '20' })
    expect(parseArgs(['service', 'install'])).toEqual({ command: 'service', sub: 'install' })
    expect(parseArgs(['status', '-h']).command).toBe('help')
    expect(parseArgs(['--version']).command).toBe('version')
    expect(parseArgs(['dictation', 'fetch'])).toEqual({ command: 'dictation', sub: 'fetch', sets: [] })
    expect(parseArgs(['dictation', 'fetch', 'runtime', 'ort', '--data-dir', '/srv/d'])).toEqual({ command: 'dictation', sub: 'fetch', sets: ['runtime', 'ort'], dataDir: '/srv/d' })
  })

  it('reads --session (a Herdr session, gone in v3) only to warn that it is ignored', () => {
    expect(parseArgs(['start', '--session=test'])).toEqual({ command: 'start', warnings: [SESSION_IGNORED] })
    expect(parseArgs(['--session', 'test', '--port', '7690'])).toEqual({ command: 'run', port: '7690', warnings: [SESSION_IGNORED] })
  })

  it('rejects unknown commands and options, missing values and bad ports', () => {
    expect(() => parseArgs(['strat'])).toThrow('unknown command: strat')
    expect(() => parseArgs(['service'])).toThrow('wherdr service install|uninstall')
    expect(() => parseArgs(['status', 'now'])).toThrow('unexpected argument: now')
    expect(() => parseArgs(['dictation'])).toThrow('usage: wherdr dictation fetch [set...]')
    expect(() => parseArgs(['--prot', '1'])).toThrow('unknown option: --prot')
    expect(() => parseArgs(['--port'])).toThrow('--port needs a value')
    expect(() => parseArgs(['--hc-socket'])).toThrow('--hc-socket needs a value')
    expect(() => parseArgs(['--session', '--port', '1'])).toThrow('--session needs a value')
    expect(() => parseArgs(['--port', '80a'])).toThrow('must be a number')
    expect(() => parseArgs(['--port=70000'])).toThrow('between 1 and 65535')
  })
})

describe('wherdr server environment', () => {
  const home = '/home/test'

  it('defaults to loopback, port 7683 and ~/wherdr/data', () => {
    const env = serverEnv({}, {}, home)
    expect(env).toMatchObject({ PORT: '7683', HOST: '127.0.0.1', DATA_DIR: '/home/test/wherdr/data', WHERDR_INSTALL: 'native', NODE_ENV: 'production' })
    expect(env.HC_SOCKET).toBeUndefined()
    expect(serverEnv({}, { WHERDR_DIR: '~/w2' }, home).DATA_DIR).toBe('/home/test/w2/data')
  })

  it('tells each installation apart for the update offered in the app', () => {
    expect(serverEnv({}, {}, home, '/opt/homebrew/Cellar/wherdr/1.3.0/libexec/lib/node_modules/wherdr/bin/wherdr.mjs').WHERDR_INSTALL).toBe('brew')
    expect(serverEnv({}, {}, home, '/home/linuxbrew/.linuxbrew/Cellar/wherdr/1.3.0/libexec/lib/node_modules/wherdr/bin/wherdr.mjs').WHERDR_INSTALL).toBe('brew')
    expect(serverEnv({}, {}, home, '/opt/homebrew/lib/node_modules/wherdr/bin/wherdr.mjs').WHERDR_INSTALL).toBe('npm-global')
    expect(serverEnv({}, {}, home, '/home/test/.npm/_npx/0a1b2c/node_modules/wherdr/bin/wherdr.mjs').WHERDR_INSTALL).toBe('npm')
    expect(serverEnv({}, {}, home, '/home/test/.npm/_npx/0a1b2c/lib/node_modules/wherdr/bin/wherdr.mjs').WHERDR_INSTALL).toBe('npm')
    expect(serverEnv({}, {}, home, '/srv/app/node_modules/wherdr/bin/wherdr.mjs').WHERDR_INSTALL).toBe('npm')
    // A source checkout; wherdr 3 is not a Herdr plugin: its old ~/wherdr/app copy is no mode of its own.
    expect(serverEnv({}, {}, home, '/home/test/src/wherdr/bin/wherdr.mjs').WHERDR_INSTALL).toBe('native')
    expect(serverEnv({}, {}, home, '/home/test/wherdr/app/bin/wherdr.mjs').WHERDR_INSTALL).toBe('native')
  })

  it('lets options win over the environment, and the environment over the defaults', () => {
    const fromEnv = serverEnv({}, { PORT: '7691', HOST: '::1', DATA_DIR: '~/elsewhere', HC_SOCKET: '~/hc/a.sock' }, home)
    expect(fromEnv).toMatchObject({ PORT: '7691', HOST: '::1', DATA_DIR: '/home/test/elsewhere', HC_SOCKET: '/home/test/hc/a.sock' })
    const fromOpts = serverEnv({ port: '7692', host: '127.0.0.2', dataDir: '/srv/w', hcSocket: '/run/b.sock' }, { PORT: '7691', HC_SOCKET: '/run/a.sock' }, home)
    expect(fromOpts).toMatchObject({ PORT: '7692', HOST: '127.0.0.2', DATA_DIR: '/srv/w', HC_SOCKET: '/run/b.sock' })
  })

  it('drops NITRO_PORT / NITRO_HOST, which Nitro would read before PORT / HOST', () => {
    const env = serverEnv({ port: '7693' }, { NITRO_PORT: '3000', NITRO_HOST: '0.0.0.0' }, home)
    expect(env.NITRO_PORT).toBeUndefined()
    expect(env.NITRO_HOST).toBeUndefined()
    expect(env.PORT).toBe('7693')
  })

  it('reads KEY=VALUE settings files', () => {
    expect(parseEnvFile('# phone\nAPP_URL="https://m.example.ts.net:7683/"\n\nexport HOST_LABEL=pi\nnot a line\n'))
      .toEqual({ APP_URL: 'https://m.example.ts.net:7683/', HOST_LABEL: 'pi' })
  })
})

describe('command context', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('takes options, then the environment, then wherdr.env, then the last start', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wherdr-ctx-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'wherdr.json'), JSON.stringify({ port: '7695', host: '127.0.0.1', hcSocket: '/run/saved.sock' }))
    const env = { WHERDR_DIR: dir }
    expect(context({}, env, '/home/test')).toMatchObject({ port: '7695', url: 'http://localhost:7695', env: { HC_SOCKET: '/run/saved.sock' } })
    expect(context({}, { ...env, HC_SOCKET: '/run/env.sock' }, '/home/test').env.HC_SOCKET).toBe('/run/env.sock')
    writeFileSync(path.join(dir, 'wherdr.env'), 'PORT=7696\nAPP_URL=https://m.example.ts.net/\n')
    expect(context({}, env, '/home/test')).toMatchObject({ port: '7696', env: { APP_URL: 'https://m.example.ts.net/' } })
    expect(context({}, { ...env, PORT: '7697' }, '/home/test').port).toBe('7697')
    expect(context({ port: '7698' }, { ...env, PORT: '7697' }, '/home/test').port).toBe('7698')
  })

  it('saves --hc-socket in wherdr.json for the next commands, and no Herdr session', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wherdr-ctx-'))
    writeFileSync(path.join(dir, 'wherdr.json'), JSON.stringify({ port: '7695', session: 'old' }))
    remember(context({ hcSocket: '/run/hc.sock' }, { WHERDR_DIR: dir }, '/home/test'))
    expect(JSON.parse(readFileSync(path.join(dir, 'wherdr.json'), 'utf8'))).toEqual({ port: '7695', host: '127.0.0.1', dataDir: path.join(dir, 'data'), hcSocket: '/run/hc.sock' })
    expect(context({}, { WHERDR_DIR: dir }, '/home/test').env.HC_SOCKET).toBe('/run/hc.sock')
  })

  it('refuses to start without HC_SOCKET and points to the migration guide', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wherdr-ctx-'))
    const ctx = context({}, { WHERDR_DIR: dir }, '/home/test')
    expect(() => needCore(ctx)).toThrow(/HC_SOCKET is not set[\s\S]*docs\/migrate-from-v2\.md/)
    expect(() => needCore(context({ hcSocket: '/run/hc.sock' }, { WHERDR_DIR: dir }, '/home/test'))).not.toThrow()
  })
})

describe('runtime and install location', () => {
  it('looks for node in version managers before Bun, WHERDR_RUNTIME first', () => {
    const list = runtimeCandidates({ WHERDR_RUNTIME: '/opt/node22/bin/node', PATH: '' }, '/home/test', '/usr/bin/node')
    expect(list[0]).toBe('/opt/node22/bin/node')
    expect(list).toContain('/home/test/.n/bin/node')
    expect(list).toContain('/home/test/.volta/bin/node')
    expect(list.indexOf('/opt/homebrew/bin/node')).toBeLessThan(list.indexOf('/home/test/.bun/bin/bun'))
  })

  it('tells temporary npx / pnpm dlx / bunx folders from a real install', () => {
    expect(temporaryInstall('/home/test/.npm/_npx/1a2b/node_modules/wherdr/bin/wherdr.mjs')).toBe(true)
    expect(temporaryInstall('/home/test/.cache/pnpm/dlx/abc/node_modules/wherdr/bin/wherdr.mjs')).toBe(true)
    expect(temporaryInstall('/tmp/bunx-501-wherdr@latest/node_modules/wherdr/bin/wherdr.mjs')).toBe(true)
    expect(temporaryInstall('/opt/homebrew/lib/node_modules/wherdr/bin/wherdr.mjs')).toBe(false)
    expect(temporaryInstall('/usr/local/lib/node_modules/wherdr/bin/wherdr.mjs')).toBe(false)
  })
})

describe('login service files', () => {
  const spec = { runtime: '/Users/test/.n/bin/node', args: ['/opt/w/bin/wherdr.mjs', 'run', '--port', '7683'], env: { PATH: '/Users/test/.n/bin:/usr/bin', APP_URL: 'https://a.example/?x=1&y=2' }, log: '/Users/test/wherdr/wherdr.log' }

  it('launchd: absolute runtime, escaped values, restart on crash only', () => {
    const plist = launchdPlist(spec)
    expect(plist).toContain('<key>Label</key><string>dev.wherdr</string>')
    expect(plist).toMatch(/<array>\s*<string>\/Users\/test\/\.n\/bin\/node<\/string>\s*<string>\/opt\/w\/bin\/wherdr\.mjs<\/string>\s*<string>run<\/string>/)
    expect(plist).toContain('<string>https://a.example/?x=1&amp;y=2</string>')
    expect(plist).toContain('<key>SuccessfulExit</key><false/>')
    expect(plist).toContain('<key>StandardErrorPath</key><string>/Users/test/wherdr/wherdr.log</string>')
  })

  it('passes HC_SOCKET to the service, never a Herdr session', () => {
    const ctx = { dir: '/home/test/wherdr', port: '7683', host: '127.0.0.1', env: { DATA_DIR: '/home/test/wherdr/data', HC_SOCKET: '/run/hc.sock', HERDR_WEB_SESSION: 'old', APP_URL: 'https://a.example/' } }
    const svc = { ...serviceSpec(ctx, '/opt/w/bin/wherdr.mjs', '/usr/bin/node', '/usr/bin'), runtime: '/usr/bin/node', log: '/home/test/wherdr/wherdr.log' }
    expect(svc.args).toEqual(['/opt/w/bin/wherdr.mjs', 'run', '--port', '7683', '--host', '127.0.0.1', '--data-dir', '/home/test/wherdr/data'])
    expect(svc.env).toEqual({ PATH: '/usr/bin', WHERDR_DIR: '/home/test/wherdr', WHERDR_RUNTIME: '/usr/bin/node', HC_SOCKET: '/run/hc.sock', APP_URL: 'https://a.example/' })
    expect(systemdUnit(svc)).toContain('Environment="HC_SOCKET=/run/hc.sock"')
    expect(launchdPlist(svc)).toContain('<key>HC_SOCKET</key><string>/run/hc.sock</string>')
    expect(systemdUnit(svc)).not.toContain('session')
  })

  it('systemd: quoted ExecStart and Environment, % escaped', () => {
    const unit = systemdUnit({ ...spec, env: { PATH: '/usr/bin', HOST_LABEL: 'my "pi" 100%' } })
    expect(unit).toContain('ExecStart="/Users/test/.n/bin/node" "/opt/w/bin/wherdr.mjs" "run" "--port" "7683"')
    expect(unit).toContain('Environment="HOST_LABEL=my \\"pi\\" 100%%"')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).toContain('Restart=on-failure')
  })
})

describe('port check', () => {
  it('tells a free port from one another program holds', async () => {
    const srv = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    const listening = Promise.withResolvers<void>()
    srv.listen(0, '127.0.0.1', () => listening.resolve())
    await listening.promise
    const port = (srv.address() as net.AddressInfo).port
    try {
      expect(await portTaken(port, '127.0.0.1')).toBe('other')
    } finally {
      const closed = Promise.withResolvers<void>()
      srv.close(() => closed.resolve())
      srv.closeAllConnections()
      await closed.promise
    }
    expect(await portTaken(port, '127.0.0.1')).toBeNull()
  })
})

describe('wherdr open', () => {
  const LOCAL = 'http://localhost:7683'
  const phone = { url: 'https://box.example.ts.net:7683/', served: true, httpsPort: '7683' }
  const net = (p: object | null) => async () => ({ installed: true, phone: p })

  it('opens the tailnet address when wherdr is published there and it answers', async () => {
    expect(await openAddress(LOCAL, '7683', { net: net(phone), reach: async () => 'ok' })).toBe('https://box.example.ts.net:7683')
  })

  it('lets wherdr allow a freshly published address, then opens it', async () => {
    const reaches = ['host', 'ok']
    const asked: string[] = []
    expect(await openAddress(LOCAL, '7683', { net: net(phone), reach: async () => reaches.shift(), allow: async (u: string) => { asked.push(u) } })).toBe('https://box.example.ts.net:7683')
    expect(asked).toEqual([LOCAL])
  })

  it('stays on localhost when unpublished, unanswered or without Tailscale', async () => {
    const never = async () => { throw new Error('not probed') }
    expect(await openAddress(LOCAL, '7683', { net: net({ ...phone, served: false }), reach: never })).toBe(LOCAL)
    expect(await openAddress(LOCAL, '7683', { net: net(null), reach: never })).toBe(LOCAL)
    expect(await openAddress(LOCAL, '7683', { net: async () => ({ installed: false }), reach: never })).toBe(LOCAL)
    expect(await openAddress(LOCAL, '7683', { net: net(phone), reach: async () => 'unreachable' })).toBe(LOCAL)
    expect(await openAddress(LOCAL, '7683', { net: net(phone), reach: async () => 'host', allow: async () => {} })).toBe(LOCAL)
  })
})

describe('wherdr doctor: herdr-core', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
  // A fake hc socket answering hello and rpc.discover from the 0.1.16 fixture.
  async function fakeHc(without = '') {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wherdr-hc-'))
    const sock = path.join(dir, 'hc.sock')
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('data', (chunk) => {
        const request = JSON.parse(chunk.toString())
        const result = request.method === 'hello'
          ? { ...fixture.hello, methods: fixture.hello.methods.filter(m => m !== without) }
          : fixture.discover
        socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(sock, resolve))
    cleanups.push(async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    })
    return sock
  }

  it('is happy with generation 1 and every required method', async () => {
    const sock = await fakeHc()
    expect(await coreRows({ HC_SOCKET: sock })).toEqual([
      ['ok', `HC_SOCKET: ${sock}`],
      ['ok', 'herdr-core 0.1.16: protocol generation 1, all required methods'],
    ])
  })

  it('names a missing method', async () => {
    const sock = await fakeHc('terminal.keep')
    expect((await coreRows({ HC_SOCKET: sock }))[1]).toEqual(['fail', 'herdr-core is missing required methods: terminal.keep. Update hc.'])
  })

  it('tells a socket that does not connect from an unset HC_SOCKET', async () => {
    const sock = path.join(os.tmpdir(), 'wherdr-hc-missing', 'hc.sock')
    expect((await coreRows({ HC_SOCKET: sock }))[1]).toEqual(['fail', `herdr-core socket does not connect: ${sock}. Start hc, or fix --hc-socket.`])
    const unset = await coreRows({})
    expect(unset).toHaveLength(1)
    expect(unset[0]).toEqual(['fail', expect.stringContaining('HC_SOCKET is not set')])
  })
})

describe('wherdr 3 without the Herdr plugin', () => {
  it('says nothing of Herdr in its help, and lists dictation fetch, not the panel', () => {
    expect(HELP).not.toMatch(/Herdr|HERDR/)
    expect(HELP).toContain('dictation fetch')
    expect(HELP).not.toMatch(/^ {2}panel/m)
  })

  it('explains that the panel is gone', () => {
    expect(() => panel()).toThrow(/wherdr 2 Herdr plugin[\s\S]*wherdr status/)
  })

  it('removes the 2.x skill only when its copy is there', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wherdr-skill-'))
    try {
      const calls: unknown[][] = []
      const run = (...args: unknown[]) => { calls.push(args); return {} }
      expect(removeLegacySkill({ WHERDR_DIR: dir }, run as never)).toBe(false)
      mkdirSync(path.join(dir, 'skills', 'wherdr'), { recursive: true })
      expect(removeLegacySkill({ WHERDR_DIR: dir }, run as never)).toBe(true)
      expect(calls).toHaveLength(1)
      expect((calls[0]![1] as string[]).slice(-1)).toEqual(['uninstall'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('wherdr dictation fetch', () => {
  it('fetches the named sets, or the default ones, into the models folder of DATA_DIR', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wherdr-dictation-'))
    try {
      const calls: unknown[][] = []
      const load = async () => ({ ...dictationFiles, fetchSets: async (...args: unknown[]) => { calls.push(args) } })
      const opts = { dataDir: path.join(dir, 'data') }
      await dictation({ ...opts, sets: ['runtime', 'ort'] }, { log: () => {}, load })
      await dictation({ ...opts, sets: [] }, { log: () => {}, load })
      expect(calls.map(c => c.slice(0, 2))).toEqual([
        [path.join(dir, 'data', 'models'), ['runtime', 'ort']],
        [path.join(dir, 'data', 'models'), dictationFiles.DEFAULT_SETS],
      ])
      await expect(dictation({ ...opts, sets: ['nope'] }, { log: () => {}, load })).rejects.toMatchObject({ code: 2, message: expect.stringContaining('unknown set: nope') })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
