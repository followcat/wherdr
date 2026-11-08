// v3 auto-deploy to the Pi: scripts/pi-deploy-v3.sh against a fake source folder,
// a fake systemctl and a health answer read from a file; scripts/pi-v3-package.sh and
// scripts/v3-builder.sh, which make that source on a dev machine.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasCommands } from './helpers/commands'

const DEPLOY = path.resolve('scripts/pi-deploy-v3.sh')
const PACKAGE = path.resolve('scripts/pi-v3-package.sh')
const BUILDER = path.resolve('scripts/v3-builder.sh')
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-pi-deploy-'))
  dirs.push(d)
  return d
}

// A built app whose /api/health answers `version` (or nothing when broken).
function build(root: string, version: string | null) {
  fs.mkdirSync(path.join(root, '.output', 'server'), { recursive: true })
  fs.writeFileSync(path.join(root, '.output', 'server', 'index.mjs'), `// server ${version}`)
  if (version) fs.writeFileSync(path.join(root, '.output', 'version'), version)
}

function setup() {
  const root = tmp()
  const dir = path.join(root, 'wherdr-v3')
  const release = path.join(root, 'release')
  const bin = path.join(root, 'bin')
  for (const d of [path.join(dir, 'src'), release, bin]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(dir, 'install-manifest.json'), JSON.stringify({ v: 1, port: '7699' }, null, 2))
  build(path.join(dir, 'src'), `3.0.0-dev+${A.slice(0, 7)}`)
  fs.mkdirSync(path.join(dir, 'deploy'))
  fs.writeFileSync(path.join(dir, 'deploy', 'commit'), `${A}\n`)
  // systemctl restart: the service now answers with the version of the build in place.
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh
echo "$*" >> "${root}/systemctl.log"
v=$(cat "${dir}/src/.output/version" 2>/dev/null) || { rm -f "${root}/health.json"; exit 0; }
printf '{"ok":true,"name":"wherdr","version":"%s"}' "$v" > "${root}/health.json"
`, { mode: 0o755 })
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root,
    WHERDR_V3_DIR: dir, WHERDR_V3_SOURCE: release, WHERDR_V3_HEALTH_URL: `file://${root}/health.json`,
    WHERDR_HEAVY_LOCK: path.join(root, 'heavy.lock'), WHERDR_V3_WAIT: '2',
  }
  const run = (...args: string[]) => spawnSync('bash', [DEPLOY, ...args], { encoding: 'utf8', env })
  const restarts = () => (fs.existsSync(path.join(root, 'systemctl.log')) ? fs.readFileSync(path.join(root, 'systemctl.log'), 'utf8').trim().split('\n') : [])
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8').trim()
  return { root, dir, release, run, restarts, read }
}

// Puts a build of <sha> in the fake source folder, as pi-v3-package.sh does.
function publish(release: string, sha: string, opts: { healthy?: boolean, badSum?: boolean } = {}) {
  const src = fs.mkdtempSync(path.join(release, '..', 'pkg-'))
  build(src, opts.healthy === false ? null : `3.0.0-dev+${sha.slice(0, 7)}`)
  fs.writeFileSync(path.join(src, 'COMMIT'), `${sha}\n`)
  execFileSync('tar', ['-czf', path.join(release, 'wherdr-v3.tgz'), '-C', src, '.output', 'COMMIT'])
  execFileSync('sh', ['-c', 'sha256sum wherdr-v3.tgz > wherdr-v3.tgz.sha256'], { cwd: release })
  if (opts.badSum) fs.writeFileSync(path.join(release, 'wherdr-v3.tgz.sha256'), `${'0'.repeat(64)}  wherdr-v3.tgz\n`)
  fs.writeFileSync(path.join(release, 'COMMIT'), `${sha}\n`)
}

describe.skipIf(!hasCommands('bash', 'curl', 'flock', 'sha256sum', 'tar'))('pi-deploy-v3.sh', () => {
  it('installs a new release, restarts and keeps the previous build', () => {
    const s = setup()
    publish(s.release, B)
    const r = s.run()
    expect(r.status, r.stderr).toBe(0)
    expect(s.read('src/.output/version')).toBe('3.0.0-dev+bbbbbbb')
    expect(s.read('deploy/commit')).toBe(B)
    expect(s.read('deploy/previous/.output/version')).toBe('3.0.0-dev+aaaaaaa')
    expect(s.restarts()).toEqual(['--user restart wherdr-v3.service'])
    expect(s.read('deploy/deploy.log')).toMatch(/OK deployed bbbbbbb \(was aaaaaaa\)$/)
  })

  it('does nothing when the release is the installed commit or has no COMMIT', () => {
    const s = setup()
    expect(s.run().status).toBe(0) // no COMMIT yet (being replaced)
    publish(s.release, A)
    expect(s.run().status).toBe(0)
    expect(s.restarts()).toEqual([])
    expect(fs.existsSync(path.join(s.dir, 'deploy', 'deploy.log'))).toBe(false)
  })

  it('refuses an archive whose checksum does not match, and leaves the build alone', () => {
    const s = setup()
    publish(s.release, B, { badSum: true })
    const r = s.run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('checksum mismatch')
    expect(s.read('src/.output/version')).toBe('3.0.0-dev+aaaaaaa')
    expect(s.restarts()).toEqual([])
  })

  it('rolls back when the new build does not answer with its version, and does not retry it', () => {
    const s = setup()
    publish(s.release, B, { healthy: false })
    const r = s.run()
    expect(r.status).toBe(1)
    expect(s.read('src/.output/version')).toBe('3.0.0-dev+aaaaaaa')
    expect(s.read('deploy/commit')).toBe(A)
    expect(s.read('deploy/failed-commit')).toBe(B)
    expect(s.restarts()).toHaveLength(2)
    expect(s.read('deploy/deploy.log')).toMatch(/ERROR bbbbbbb does not answer[\s\S]*ROLLBACK back to aaaaaaa$/)
    expect(s.run().status).toBe(0)
    expect(s.restarts()).toHaveLength(2)
  })

  it('rolls back by hand, and prepare installs without restarting', () => {
    const s = setup()
    publish(s.release, B)
    expect(s.run('prepare').status).toBe(0)
    expect(s.restarts()).toEqual([])
    expect(s.read('src/.output/version')).toBe('3.0.0-dev+bbbbbbb')
    expect(s.run('rollback').status).toBe(0)
    expect(s.read('src/.output/version')).toBe('3.0.0-dev+aaaaaaa')
    expect(s.read('deploy/commit')).toBe(A)
    expect(s.read('deploy/failed-commit')).toBe(B) // the timer does not put it back
    expect(s.restarts()).toEqual(['--user restart wherdr-v3.service'])
    expect(s.run('rollback').status).toBe(1) // nothing left to go back to
  })

  it('refuses a folder that is not a v3 install', () => {
    const s = setup()
    fs.rmSync(path.join(s.dir, 'install-manifest.json'))
    publish(s.release, B)
    const r = s.run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('is not a v3 install')
    expect(s.read('src/.output/version')).toBe('3.0.0-dev+aaaaaaa')
  })
})

describe.skipIf(!hasCommands('bash', 'tar', 'sha256sum'))('pi-v3-package.sh', () => {
  const pkg = (extra?: (root: string) => void, version = `3.0.0-dev+${A.slice(0, 7)}`) => {
    const root = tmp()
    build(root, version)
    extra?.(root)
    return { root, r: spawnSync('bash', [PACKAGE, path.join(root, 'www'), A], { cwd: root, encoding: 'utf8' }) }
  }

  it('packs .output and COMMIT with its checksum, COMMIT beside it', () => {
    const { root, r } = pkg()
    expect(r.status, r.stderr).toBe(0)
    const out = path.join(root, 'www')
    expect(fs.readFileSync(path.join(out, 'COMMIT'), 'utf8').trim()).toBe(A)
    expect(execFileSync('tar', ['-tzf', path.join(out, 'wherdr-v3.tgz')], { encoding: 'utf8' })).toMatch(/^COMMIT$/m)
    expect(execFileSync('sha256sum', ['-c', 'wherdr-v3.tgz.sha256'], { cwd: out, encoding: 'utf8' })).toContain('OK')
  })

  it('refuses native code, links, and a build of another commit', () => {
    for (const add of [
      (r: string) => fs.writeFileSync(path.join(r, '.output', 'server', 'x.node'), ''),
      (r: string) => fs.writeFileSync(path.join(r, '.output', 'server', 'bin'), Buffer.from('7f454c4602010100', 'hex')),
      (r: string) => fs.symlinkSync('index.mjs', path.join(r, '.output', 'server', 'link.mjs')),
    ]) {
      const { r } = pkg(add)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('native code or links')
    }
    const { r } = pkg(undefined, '3.0.0-dev+bbbbbbb')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('was not built from aaaaaaa')
  })
})

describe.skipIf(!hasCommands('bash', 'git', 'tar', 'sha256sum', 'flock'))('v3-builder.sh', () => {
  it('builds a new commit of origin/v3 once and serves it at the top of www/', () => {
    const root = tmp()
    const repo = path.join(root, 'repo')
    const bin = path.join(root, 'bin')
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
    fs.mkdirSync(bin)
    fs.copyFileSync(PACKAGE, path.join(repo, 'scripts', 'pi-v3-package.sh'))
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'v3')
    git('add', '.')
    git('commit', '-qm', 'one')
    // npm: `run build` makes a .output that answers the version of HEAD.
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
echo "npm $*" >> "${root}/npm.log"
[ "$1" = run ] || exit 0
mkdir -p .output/server && echo "// 3.0.0-dev+$(git rev-parse --short=7 HEAD)" > .output/server/index.mjs
`, { mode: 0o755 })
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WHERDR_V3_BUILDER_DIR: path.join(root, 'b'), WHERDR_V3_REPO: repo, WHERDR_HEAVY_LOCK: path.join(root, 'lock') }
    const run = () => spawnSync('bash', [BUILDER], { encoding: 'utf8', env })
    const served = () => fs.readFileSync(path.join(root, 'b', 'www', 'COMMIT'), 'utf8').trim()
    expect(run().status).toBe(0)
    expect(served()).toBe(git('rev-parse', 'HEAD'))
    expect(run().status).toBe(0) // same commit: no new build
    expect(fs.readFileSync(path.join(root, 'npm.log'), 'utf8').match(/run build/g)).toHaveLength(1)
    git('commit', '-q', '--allow-empty', '-m', 'two')
    expect(run().status).toBe(0)
    expect(served()).toBe(git('rev-parse', 'HEAD'))
    expect(fs.readdirSync(path.join(root, 'b', 'www', 'builds'))).toHaveLength(2)
    expect(fs.readFileSync(path.join(root, 'b', 'builds.log'), 'utf8')).toMatch(/OK built [0-9a-f]{7}\n.*OK built [0-9a-f]{7}\n$/)
  })
})
