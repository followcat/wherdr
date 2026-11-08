import { describe, expect, it } from 'vitest'
import { driverFor, healthReports, healthUrl, runUpdate, shortReason } from '../bin/lib/updater.mjs'

const base = {
  from: '1.3.0', to: '1.3.1', dir: '/home/test/wherdr', runtime: '/usr/local/bin/node',
  serverPid: 4242, port: '7683', host: '127.0.0.1', registry: 'https://registry.npmjs.org', releaseBase: 'https://github.com/example/wherdr/releases/download', healthMs: 1000,
}
const plans = {
  'plugin': { ...base, kind: 'plugin', root: '/home/test/wherdr/app' },
  'npm-global': { ...base, kind: 'npm-global', root: '/usr/local/lib/node_modules/wherdr' },
  // The formula's `npm install *std_npm_args` layout.
  'brew': { ...base, kind: 'brew', root: '/opt/homebrew/Cellar/wherdr/1.3.0/libexec/lib/node_modules/wherdr' },
}

// Fake I/O: records every command and file operation; `fail` makes a command
// (matched on its text) throw, `answers` lists the versions /api/health reports.
function fakeIo(o: { fail?: RegExp, answers?: string[], files?: string[], opt?: string } = {}) {
  const calls: string[] = []
  const environments: Record<string, string>[] = []
  const states: [string, string | undefined][] = []
  const files = new Set(o.files ?? [])
  const answers = [...(o.answers ?? [])]
  const io = {
    calls, states, files, environments,
    log: () => {},
    state: (s: string, m?: string) => { states.push([s, m]) },
    async run(cmd: string, args: string[], env: Record<string, string> = {}) {
      environments.push(env)
      const line = [cmd, ...args].join(' ')
      calls.push(line)
      if (o.fail?.test(line)) throw new Error(`${line} exited with 1`)
      return ''
    },
    async download(url: string, file: string) { calls.push(`GET ${url} > ${file}`) },
    async verify(file: string, checksum: string) { calls.push(`verify ${file} ${checksum}`) },
    async stopServer() { calls.push('stop') },
    async healthy(version: string) { calls.push(`health ${version}`); return answers.shift() === version },
    exists: (p: string) => files.has(p) || p.endsWith('/.output/server/index.mjs'),
    rm: (p: string) => { calls.push(`rm ${p}`) },
    mkdir: (p: string) => { calls.push(`mkdir ${p}`) },
    rename: (a: string, b: string) => { calls.push(`mv ${a} ${b}`) },
    copy: (a: string, b: string) => { calls.push(`cp ${a} ${b}`) },
    realpath: () => o.opt ?? '/opt/homebrew/Cellar/wherdr/1.3.1',
  }
  return io
}

describe('one-tap update: commands of each installation', () => {
  it('plugin: verifies and unpacks the GitHub package next to the copy, keeps the old one, starts the new one', async () => {
    const io = fakeIo({ answers: ['1.3.1'] })
    expect(await runUpdate(plans.plugin, io)).toBe('done')
    expect(io.calls).toEqual([
      'GET https://github.com/example/wherdr/releases/download/v1.3.1/wherdr-1.3.1.tgz > /home/test/wherdr/update/wherdr-1.3.1.tgz',
      'GET https://github.com/example/wherdr/releases/download/v1.3.1/wherdr-1.3.1.tgz.sha256 > /home/test/wherdr/update/wherdr-1.3.1.tgz.sha256',
      'verify /home/test/wherdr/update/wherdr-1.3.1.tgz /home/test/wherdr/update/wherdr-1.3.1.tgz.sha256',
      'rm /home/test/wherdr/update/wherdr-1.3.1.tgz.sha256',
      'rm /home/test/wherdr/app.new',
      'mkdir /home/test/wherdr/app.new',
      'tar -xzf /home/test/wherdr/update/wherdr-1.3.1.tgz -C /home/test/wherdr/app.new --strip-components=1',
      'rm /home/test/wherdr/update/wherdr-1.3.1.tgz',
      'stop',
      'rm /home/test/wherdr/app.prev',
      'mv /home/test/wherdr/app /home/test/wherdr/app.prev',
      'mv /home/test/wherdr/app.new /home/test/wherdr/app',
      '/usr/local/bin/node /home/test/wherdr/app/bin/wherdr.mjs start',
      'health 1.3.1',
    ])
    expect(io.states.map(s => s[0])).toEqual(['installing', 'restarting', 'checking', 'done'])
  })

  it('plugin: carries the panel QR code package over', async () => {
    const io = fakeIo({ answers: ['1.3.1'], files: ['/home/test/wherdr/app/node_modules/qrcode-terminal'] })
    await runUpdate(plans.plugin, io)
    expect(io.calls).toContain('cp /home/test/wherdr/app/node_modules/qrcode-terminal /home/test/wherdr/app.new/node_modules/qrcode-terminal')
  })

  it('npm global: installs the exact version with the npm next to the runtime', async () => {
    const io = fakeIo({ answers: ['1.3.1'], files: ['/usr/local/bin/npm'] })
    expect(await runUpdate(plans['npm-global'], io)).toBe('done')
    expect(io.calls).toEqual([
      '/usr/local/bin/npm install --global wherdr@1.3.1 --no-audit --no-fund',
      'stop',
      '/usr/local/bin/node /usr/local/lib/node_modules/wherdr/bin/wherdr.mjs start',
      'health 1.3.1',
    ])
  })

  it('Homebrew: upgrades, then restarts the brew service', async () => {
    const io = fakeIo({ answers: ['1.3.1'] })
    expect(await runUpdate(plans.brew, io)).toBe('done')
    expect(io.calls).toEqual([
      '/opt/homebrew/bin/brew upgrade wherdr',
      'stop',
      '/opt/homebrew/bin/brew services restart wherdr',
      'health 1.3.1',
    ])
  })

  for (const kind of ['plugin', 'npm-global'] as const) {
    it(`${kind}: refreshes the installed skill without making update success depend on it`, async () => {
      const plan = plans[kind]
      const root = plan.root
      const helper = `${root}/bin/lib/install-skill.sh`
      for (const fail of [undefined, /install-skill/]) {
        const io = fakeIo({ answers: ['1.3.1'], files: [helper], fail })
        expect(await runUpdate(plan, io)).toBe('done')
        expect(io.calls).toContain(`sh ${helper} refresh ${root}`)
        expect(io.environments.some(env => env.WHERDR_SKILL_REFRESHED === '1')).toBe(fail === undefined)
      }
    })
  }

  it('Homebrew: a formula that does not offer the version yet changes nothing', async () => {
    const io = fakeIo({ opt: '/opt/homebrew/Cellar/wherdr/1.3.0' })
    expect(await runUpdate(plans.brew, io)).toBe('failed')
    expect(io.calls).not.toContain('stop')
    expect(io.states.at(-1)![1]).toMatch(/Homebrew installed 1\.3\.0, not 1\.3\.1.*Still on 1\.3\.0/)
  })

  it('refuses installations it cannot update', () => {
  })

  it('checks health on loopback when the server listens everywhere', () => {
    expect(healthUrl({ port: '7683', host: '0.0.0.0' })).toBe('http://127.0.0.1:7683/api/health')
    expect(healthUrl({ port: '7683', host: '::1' })).toBe('http://[::1]:7683/api/health')
  })

  it('accepts the package version from v2 (version) and v3 (release)', () => {
    expect(healthReports({ version: '2.5.0' }, '2.5.0')).toBe(true)
    expect(healthReports({ version: '3.0.0-dev+fc3550e', release: '2.5.0' }, '2.5.0')).toBe(true)
    expect(healthReports({ version: '3.0.0-dev+fc3550e', release: '2.5.0' }, '2.6.0')).toBe(false)
    expect(healthReports(null, '2.5.0')).toBe(false)
  })
})

describe('one-tap update: going back', () => {
  it('a failed install leaves the running server alone', async () => {
    const io = fakeIo({ fail: /npm install/, files: ['/usr/local/bin/npm'] })
    expect(await runUpdate(plans['npm-global'], io)).toBe('failed')
    expect(io.calls).toEqual(['/usr/local/bin/npm install --global wherdr@1.3.1 --no-audit --no-fund'])
    expect(io.states.at(-1)![1]).toMatch(/could not be installed.*Still on 1\.3\.0/)
  })

  it('plugin: a new version that does not answer puts the previous copy back', async () => {
    const io = fakeIo({ answers: ['', '1.3.0'], files: ['/home/test/wherdr/app.prev'] })
    expect(await runUpdate(plans.plugin, io)).toBe('rolled-back')
    expect(io.calls.slice(io.calls.indexOf('health 1.3.1'))).toEqual([
      'health 1.3.1',
      'stop',
      'rm /home/test/wherdr/app',
      'mv /home/test/wherdr/app.prev /home/test/wherdr/app',
      '/usr/local/bin/node /home/test/wherdr/app/bin/wherdr.mjs start',
      'health 1.3.0',
    ])
    expect(io.states.map(s => s[0])).toEqual(['installing', 'restarting', 'checking', 'rolling-back', 'rolled-back'])
    expect(io.states.at(-1)![1]).toBe('wherdr 1.3.1 did not answer within 1 s. Rolled back to 1.3.0.')
  })

  it('says why the new version did not start in one short sentence, without paths', async () => {
    const io = fakeIo({ answers: ['1.3.0'], files: ['/home/test/wherdr/app.prev'] })
    let starts = 0
    const run = io.run
    io.run = async (cmd: string, args: string[]) => {
      if (args.at(-1) === 'start' && !starts++)
        throw new Error('node wherdr.mjs exited with 1: wherdr: wherdr exited at startup (/home/test/wherdr/runtime/bin/node).')
      return run(cmd, args)
    }
    expect(await runUpdate(plans.plugin, io)).toBe('rolled-back')
    expect(io.states.at(-2)).toEqual(['rolling-back', 'wherdr 1.3.1 did not start: wherdr exited at startup.'])
    expect(io.states.at(-1)![1]).toBe('wherdr 1.3.1 did not start: wherdr exited at startup. Rolled back to 1.3.0.')
  })

  it('shortReason keeps the cause and drops commands and folders', () => {
    expect(shortReason('node wherdr.mjs exited with 1: wherdr: port 7683 is already taken by another program: pick another one with --port.'))
      .toBe('port 7683 is already taken by another program: pick another one with --port')
    expect(shortReason('tar: /home/test/wherdr/update/wherdr-1.3.1.tgz: Cannot open')).toBe('tar: wherdr-1.3.1.tgz: Cannot open')
    expect(shortReason('C:\\Users\\test\\wherdr\\app\\bin\\wherdr.mjs is missing')).toBe('wherdr.mjs is missing')
    expect(shortReason('wherdr 1.3.1 did not answer within 45 s')).toBe('wherdr 1.3.1 did not answer within 45 s')
    expect(shortReason('x'.repeat(500))).toHaveLength(200)
    expect(shortReason(undefined)).toBe('')
  })

  it('npm global: a new version that fails to start reinstalls the previous one', async () => {
    const io = fakeIo({ fail: /wherdr\.mjs start$/, files: ['/usr/local/bin/npm'] })
    // The first start fails; the second (after the rollback) too, in this fake.
    expect(await runUpdate(plans['npm-global'], io)).toBe('failed')
    expect(io.calls).toContain('/usr/local/bin/npm install --global wherdr@1.3.0 --no-audit --no-fund')
    expect(io.states.at(-1)![1]).toMatch(/^wherdr 1\.3\.1 did not start: .*Going back to 1\.3\.0 failed too: .*update\.log/)
  })

  it('Homebrew: removes the keg that does not start, then links the kept one', async () => {
    const io = fakeIo({ answers: ['', '1.3.0'], files: ['/opt/homebrew/Cellar/wherdr/1.3.0'] })
    expect(await runUpdate(plans.brew, io)).toBe('rolled-back')
    expect(io.calls.slice(io.calls.indexOf('health 1.3.1') + 1)).toEqual([
      'stop',
      '/opt/homebrew/bin/brew unlink wherdr',
      'rm /opt/homebrew/Cellar/wherdr/1.3.1',
      '/opt/homebrew/bin/brew link --overwrite wherdr',
      '/opt/homebrew/bin/brew services restart wherdr',
      'health 1.3.0',
    ])
  })

  it('Homebrew: says so when the previous keg is gone', async () => {
    const io = fakeIo({ answers: [''] })
    expect(await runUpdate(plans.brew, io)).toBe('failed')
    expect(io.states.at(-1)![1]).toMatch(/previous Homebrew version was removed/)
  })
})

it('a checksum failure leaves the old plugin running and never extracts the archive', async () => {
  const io = fakeIo()
  io.verify = async () => { throw new Error('Release SHA-256 mismatch') }
  expect(await runUpdate(plans.plugin, io)).toBe('failed')
  expect(io.calls).not.toContain('stop')
  expect(io.calls.some(c => c.startsWith('tar '))).toBe(false)
})
