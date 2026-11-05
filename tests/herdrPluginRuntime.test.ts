// scripts/herdr-plugin.sh in native mode: Herdr runs the actions with its
// server's PATH, which may not contain node (n, nvm…). The runtime found at
// install time must be saved and used by start. Herdr builds in a temporary
// folder then moves it: the build starts wherdr from a copy that stays put.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '..')
// No `tar`: the build must not download the published npm package (it would
// replace the stand-in server below); it falls back to the stubbed npm build.
const TOOLS = ['sh', 'dirname', 'basename', 'sed', 'tr', 'head', 'tail', 'cat', 'ps', 'grep', 'curl', 'mkdir', 'touch', 'wc', 'sleep', 'nohup', 'ls', 'sort', 'id', 'uname', 'rm', 'mv', 'cp', 'mktemp', 'printf', 'setsid', 'awk']

async function freePort() {
  const srv = net.createServer()
  const ready = Promise.withResolvers<void>()
  srv.listen(0, '127.0.0.1', () => ready.resolve())
  await ready.promise
  const port = (srv.address() as net.AddressInfo).port
  const closed = Promise.withResolvers<void>()
  srv.close(() => closed.resolve())
  await closed.promise
  return port
}

function which(cmd: string) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

// Each case runs the real script (one or two builds, ~1-4 s alone): over Vitest's 5 s
// default when the whole suite loads the machine.
describe.skipIf(process.platform === 'win32' || !which('curl'))('herdr plugin, native runtime', { timeout: 20_000 }, () => {
  let tmp: string, root: string, home: string, rt: string, minbin: string, port: number

  beforeEach(async () => {
    // realpath: on macOS the temp folder is a link (/var → /private/var).
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wherdr-plugin-')))
    root = path.join(tmp, 'root'); home = path.join(tmp, 'home'); rt = path.join(tmp, 'rt'); minbin = path.join(tmp, 'minbin')
    for (const d of [path.join(root, 'scripts'), path.join(root, '.output', 'server'), home, rt, minbin]) mkdirSync(d, { recursive: true })
    cpSync(path.join(REPO, 'scripts', 'herdr-plugin.sh'), path.join(root, 'scripts', 'herdr-plugin.sh'))
    cpSync(path.join(REPO, 'herdr-plugin.toml'), path.join(root, 'herdr-plugin.toml'))
    cpSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'))
    cpSync(path.join(REPO, 'bin'), path.join(root, 'bin'), { recursive: true })
    cpSync(path.join(REPO, 'skills'), path.join(root, 'skills'), { recursive: true })
    // Stand-in server: answers on $PORT like wherdr (its manifest names it).
    writeFileSync(path.join(root, '.output', 'server', 'index.mjs'),
      `import http from 'node:http'\nhttp.createServer((q, s) => s.end('{"name":"wherdr"}')).listen(Number(process.env.PORT), process.env.HOST)\n`)
    // node only in a version-manager-like folder; npm stubbed (no real build).
    symlinkSync(process.execPath, path.join(rt, 'node'))
    writeFileSync(path.join(rt, 'npm'), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(rt, 'npm'), 0o755)
    // Left by npm ci: the panel's QR code package, so nothing is downloaded.
    mkdirSync(path.join(root, 'node_modules', 'qrcode-terminal'), { recursive: true })
    writeFileSync(path.join(root, 'node_modules', 'qrcode-terminal', 'package.json'), '{}')
    for (const t of TOOLS) { const p = which(t); if (p) symlinkSync(p, path.join(minbin, t)) }
    port = await freePort()
  })

  afterEach(() => {
    const pidfile = path.join(home, 'wherdr', 'wherdr.pid')
    if (existsSync(pidfile)) try { process.kill(Number(readFileSync(pidfile, 'utf8'))) } catch {}
    rmSync(tmp, { recursive: true, force: true })
  })

  // Like Herdr's server: a bare environment whose PATH has no node.
  const run = (action: string, extraPath = '', extraEnv: Record<string, string> = {}) => spawnSync('sh', [path.join(root, 'scripts', 'herdr-plugin.sh'), action], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { HOME: home, HC_SOCKET: path.join(home, 'hc.sock'), PATH: extraPath ? `${extraPath}:${minbin}` : minbin, WHERDR_MODE: 'native', WHERDR_PORT: String(port), ...extraEnv },
  })

  const pidOf = () => readFileSync(path.join(home, 'wherdr', 'wherdr.pid'), 'utf8').trim()

  it('installs a copy outside the checkout and starts it at the end of the build, with the saved runtime', () => {
    // Install (fetch of the npm package fails offline or for an unpublished version: stub build).
    const build = run('build', rt)
    expect(build.status, build.stderr).toBe(0)
    expect(build.stdout).toContain(`✓ wherdr is running → http://localhost:${port}`)
    const summary = build.stdout.slice(build.stdout.indexOf('✓ wherdr is running'))
    expect(summary.indexOf('In Herdr, prefix+i opens the wherdr panel.')).toBeGreaterThan(0)
    expect(summary.indexOf('Setup guide:')).toBeGreaterThan(summary.indexOf('In Herdr,'))
    expect(summary.indexOf('Phone: press P')).toBeGreaterThan(summary.indexOf('Setup guide:'))
    expect(summary).not.toContain('key above')
    expect(readFileSync(path.join(home, 'wherdr', 'plugin.env'), 'utf8')).toContain(`WHERDR_RUNTIME=${path.join(rt, 'node')}`)
    const pid = pidOf()
    const cmd = existsSync(`/proc/${pid}/cmdline`) ? readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') : execFileSync('ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8' })
    expect(cmd).toContain(`${path.join(rt, 'node')} ${path.join(home, 'wherdr', 'app', '.output', 'server', 'index.mjs')}`)
    expect(existsSync(path.join(home, 'wherdr', 'app', 'node_modules', 'qrcode-terminal'))).toBe(true)

    // Herdr then moves the checkout: wherdr keeps running, and the moved
    // plugin, from a PATH without node, still controls it.
    const moved = path.join(tmp, 'moved')
    renameSync(root, moved)
    root = moved
    expect(spawnSync('sh', ['-c', 'command -v node'], { env: { PATH: minbin } }).status).not.toBe(0)
    expect(run('start').stdout).toContain('nothing to start')
    expect(run('stop').stdout).toContain(`wherdr stopped (pid ${pid})`)
    const start = run('start')
    expect(start.status, start.stderr).toBe(0)
    expect(start.stdout).toContain('wherdr started')
  })

  it('switches an existing Docker plugin install to native without running the old runtime', () => {
    const dir = path.join(home, 'wherdr')
    mkdirSync(path.join(dir, 'data'), { recursive: true })
    writeFileSync(path.join(dir, 'plugin.env'), `WHERDR_MODE=docker\nWHERDR_PORT=${port}\n`)
    writeFileSync(path.join(dir, 'data', 'settings.json'), '{"theme":"titanium"}')
    writeFileSync(path.join(minbin, 'docker'), '#!/bin/sh\necho unexpected > "$HOME/docker-called"\nexit 1\n', { mode: 0o755 })
    const build = run('build', rt)
    expect(build.status, build.stderr).toBe(0)
    expect(build.stdout).toContain('switching this plugin to the native service')
    expect(build.stdout).toContain('Stop the old 1.x instance')
    expect(readFileSync(path.join(dir, 'plugin.env'), 'utf8')).not.toContain('WHERDR_MODE')
    expect(readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8')).toBe('{"theme":"titanium"}')
    expect(existsSync(path.join(home, 'docker-called'))).toBe(false)
    expect(pidOf()).toMatch(/^\d+$/)
    expect(run('stop').status).toBe(0)
    expect(run('start').stdout).toContain('wherdr started')
  })

  it('restarts the wherdr it runs on the new copy when installed again', () => {
    expect(run('build', rt).status).toBe(0)
    const first = pidOf()
    const again = run('build', rt)
    expect(again.status, again.stderr).toBe(0)
    expect(again.stdout).toContain('✓ wherdr is running')
    expect(pidOf()).not.toBe(first)
    expect(() => process.kill(Number(first), 0)).toThrow()
  })

  it('keeps the install when wherdr cannot start, and says why', () => {
    writeFileSync(path.join(root, '.output', 'server', 'index.mjs'), 'console.error("cannot open the Herdr socket"); process.exit(3)\n')
    const build = run('build', rt)
    expect(build.status, build.stderr).toBe(0)
    expect(build.stdout).not.toContain('✓ wherdr is running')
    expect(build.stdout).toContain('wherdr is installed but did not start')
    expect(build.stdout).toContain('cannot open the Herdr socket')
    expect(existsSync(path.join(home, 'wherdr', 'app', 'bin', 'wherdr.mjs'))).toBe(true)
  })

  // A fake `tailscale` whose `serve status --json` is `serve`, and a `curl`
  // that answers like wherdr for the tailnet name (no tailnet in the tests).
  // `answers` 'refused': wherdr answers there but its host check refuses the
  // name (/api/health → 403 host), while the static manifest still answers.
  function fakeTailnet(serve: string, answers: boolean | 'refused' = true) {
    const dir = path.join(tmp, 'tailnet')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'serve.json'), serve)
    writeFileSync(path.join(dir, 'tailscale'), `#!/bin/sh\n[ "$1 $2 $3" = "serve status --json" ] && cat "${dir}/serve.json"\nexit 0\n`)
    const refused = `https://box.example.ts.net*/api/health) echo '{"error":"Host not allowed","code":"host"}'; exit 0 ;; `
    writeFileSync(path.join(dir, 'curl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in ${answers === 'refused' ? refused : ''}https://box.example.ts.net*) ${answers ? `echo '{"name":"wherdr"}'; exit 0` : 'exit 7'} ;; esac; done\nexec ${which('curl')} "$@"\n`)
    chmodSync(path.join(dir, 'tailscale'), 0o755); chmodSync(path.join(dir, 'curl'), 0o755)
    return dir
  }
  const served = (httpsPort: number, target: number) => JSON.stringify({
    TCP: { [httpsPort]: { HTTPS: true } },
    Web: {
      'box.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } },
      [`box.example.ts.net:${httpsPort}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${target}` } } },
    },
  }, null, 2)

  it('opens the tailnet address when wherdr is already published there and it answers', () => {
    const first = run('build', `${fakeTailnet(served(port, port))}:${rt}`, { WHERDR_NO_BROWSER: '1' })
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain(`Setup guide: open https://box.example.ts.net:${port}/#/setup in a browser`)
    expect(run('address', path.join(tmp, 'tailnet')).stdout.trim()).toBe(`https://box.example.ts.net:${port}`)
    expect(run('open', path.join(tmp, 'tailnet'), { WHERDR_NO_BROWSER: '1' }).stdout.trim()).toBe(`https://box.example.ts.net:${port}`)
    // Published on the default HTTPS port, in one line of JSON: no port in the address.
    writeFileSync(path.join(tmp, 'tailnet', 'serve.json'), JSON.stringify(JSON.parse(served(443, port))))
    expect(run('address', path.join(tmp, 'tailnet')).stdout.trim()).toBe('https://box.example.ts.net')
  })

  it('stays on localhost when nothing is published for its port, or the address does not answer', () => {
    const local = `http://localhost:${port}`
    const first = run('build', `${fakeTailnet(served(port, port + 1))}:${rt}`, { WHERDR_NO_BROWSER: '1' })
    expect(first.stdout).toContain(`Setup guide: open ${local}/#/setup in a browser`)
    expect(run('address', path.join(tmp, 'tailnet')).stdout.trim()).toBe(local)
    expect(run('address', fakeTailnet(served(port, port), false)).stdout.trim()).toBe(local)
    expect(run('address', fakeTailnet('{}')).stdout.trim()).toBe(local)
    // wherdr refuses the name: its manifest answers all the same, /api/health tells.
    expect(run('address', fakeTailnet(served(port, port), 'refused')).stdout.trim()).toBe(local)
    expect(run('address').stdout.trim()).toBe(local)
  })

  it('starts nothing at install when something already answers on the port', async () => {
    // Another program, in a child: spawnSync blocks this process's event loop.
    const other = spawn(process.execPath, ['-e', `require('http').createServer((q, s) => s.end('other')).listen(${port}, '127.0.0.1', () => console.log('up'))`])
    try {
      await once(other.stdout, 'data')
      const build = run('build', rt)
      expect(build.status, build.stderr).toBe(0)
      expect(build.stdout).toContain('nothing to start')
      expect(existsSync(path.join(home, 'wherdr', 'wherdr.pid'))).toBe(false)
    } finally { other.kill() }
  })

  it('finds a runtime in the usual folders when the saved one is gone', () => {
    expect(run('build', rt).status).toBe(0)
    expect(run('stop').status).toBe(0)
    unlinkSync(path.join(rt, 'node'))
    mkdirSync(path.join(home, '.n', 'bin'), { recursive: true })
    symlinkSync(process.execPath, path.join(home, '.n', 'bin', 'node'))
    const start = run('start')
    expect(start.status, start.stderr).toBe(0)
    // Unless the machine has a node 22 in /usr/local/bin or Homebrew, which is checked after ~/.n.
    expect(readFileSync(path.join(home, 'wherdr', 'plugin.env'), 'utf8')).toContain(`WHERDR_RUNTIME=${path.join(home, '.n', 'bin', 'node')}`)
  })

  it('reports a server that exits at startup with the end of its log, never "started"', () => {
    expect(run('build', rt).status).toBe(0)
    expect(run('stop').status).toBe(0)
    writeFileSync(path.join(home, 'wherdr', 'app', '.output', 'server', 'index.mjs'), 'console.error("cannot open the Herdr socket"); process.exit(3)\n')
    const start = run('start')
    expect(start.status).toBe(1)
    expect(start.stdout).not.toContain('wherdr started')
    expect(start.stderr).toContain('wherdr exited at startup')
    expect(start.stderr).toContain('cannot open the Herdr socket')
  })

  // Stand-in browser openers: each call is recorded, nothing is opened.
  function fakeOpeners() {
    const fake = path.join(tmp, 'fakebin'); const calls = path.join(tmp, 'opened.log')
    mkdirSync(fake, { recursive: true })
    for (const cmd of ['open', 'xdg-open']) {
      writeFileSync(path.join(fake, cmd), `#!/bin/sh\necho "${cmd} $*" >> "${calls}"\n`); chmodSync(path.join(fake, cmd), 0o755)
    }
    // Linux unless a test says otherwise (the suite also runs on a Mac).
    writeFileSync(path.join(fake, 'uname'), '#!/bin/sh\necho Linux\n'); chmodSync(path.join(fake, 'uname'), 0o755)
    const opened = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
    return { fake, opened }
  }

  it('opens the setup guide in the browser once, at the first install only', () => {
    const { fake, opened } = fakeOpeners()
    const first = run('build', `${rt}:${fake}`, { DISPLAY: ':0' })
    expect(first.status, first.stderr).toBe(0)
    // xdg-open runs in the background.
    for (let i = 0; i < 50 && !opened().length; i++) spawnSync('sleep', ['0.1'])
    expect(opened()).toEqual([`xdg-open http://localhost:${port}/#/setup`])
    expect(first.stdout).toContain('Setup guide opened in your browser')
    // An update (plugin.env kept) opens nothing.
    const update = run('build', `${rt}:${fake}`, { DISPLAY: ':0' })
    expect(update.status, update.stderr).toBe(0)
    spawnSync('sleep', ['0.3'])
    expect(opened()).toHaveLength(1)
  })

  it('uses open on macOS', () => {
    const { fake, opened } = fakeOpeners()
    writeFileSync(path.join(fake, 'uname'), '#!/bin/sh\necho Darwin\n'); chmodSync(path.join(fake, 'uname'), 0o755)
    const build = run('build', `${fake}:${rt}`)
    expect(build.status, build.stderr).toBe(0)
    expect(opened()).toEqual([`open http://localhost:${port}/#/setup`])
  })

  it('opens no browser on a server without a display, and prints the address', () => {
    const { fake, opened } = fakeOpeners()
    const build = run('build', `${rt}:${fake}`)
    expect(build.status, build.stderr).toBe(0)
    spawnSync('sleep', ['0.3'])
    expect(opened()).toEqual([])
    expect(build.stdout).toContain(`Setup guide: open http://localhost:${port}/#/setup`)
  })
})
