import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repo = path.resolve('.')
const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(mode: string) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-skill-'))
  temporary.push(home)
  const root = path.join(home, mode === 'brew' ? 'Cellar/wherdr/1.0/libexec/lib/node_modules/wherdr' : 'package')
  mkdirSync(root, { recursive: true })
  cpSync(path.join(repo, 'bin'), path.join(root, 'bin'), { recursive: true })
  cpSync(path.join(repo, 'skills'), path.join(root, 'skills'), { recursive: true })
  cpSync(path.join(repo, 'package.json'), path.join(root, 'package.json'))
  mkdirSync(path.join(root, 'scripts'))
  cpSync(path.join(repo, 'scripts/herdr-plugin.sh'), path.join(root, 'scripts/herdr-plugin.sh'))
  cpSync(path.join(repo, 'herdr-plugin.toml'), path.join(root, 'herdr-plugin.toml'))
  const bin = path.join(home, 'tools')
  mkdirSync(bin)
  const env = { ...process.env, HOME: home, HC_SOCKET: path.join(home, 'hc.sock'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), WHERDR_DIR: path.join(home, 'wherdr'), IMAGE_ROOT: root, PATH: `${bin}:${process.env.PATH}` }
  const source = path.join(root, 'skills/wherdr/SKILL.md')
  // wherdr 3's CLI installs no skill: only the wherdr 2 Herdr plugin script does.
  const run = () => { execFileSync('sh', [path.join(root, 'scripts/herdr-plugin.sh'), 'skill', 'install'], { env }) }
  return { home, root, source, run, env, copy: path.join(home, 'wherdr/skills/wherdr'), link: path.join(home, '.claude/skills/wherdr') }
}

for (const mode of ['plugin-native']) {
  describe(`skill installation: ${mode}`, () => {
    it('installs for existing agents and refreshes the stable copy after an update', () => {
      const f = fixture(mode)
      mkdirSync(path.join(f.home, '.claude'))
      mkdirSync(path.join(f.home, '.codex'))
      f.run()
      expect(readlinkSync(f.link)).toBe(f.copy)
      expect(readlinkSync(path.join(f.home, '.agents/skills/wherdr'))).toBe(f.copy)
      expect(readFileSync(path.join(f.link, 'SKILL.md'), 'utf8')).toBe(readFileSync(f.source, 'utf8'))
      writeFileSync(f.source, 'updated release')
      f.run()
      expect(readFileSync(path.join(f.link, 'SKILL.md'), 'utf8')).toBe('updated release')
    })

    it('preserves a foreign skill directory and a dangling foreign link', () => {
      const f = fixture(mode)
      mkdirSync(f.link, { recursive: true })
      writeFileSync(path.join(f.link, 'SKILL.md'), 'foreign')
      mkdirSync(path.join(f.home, '.agents/skills'), { recursive: true })
      symlinkSync(path.join(f.home, 'missing'), path.join(f.home, '.agents/skills/wherdr'))
      f.run()
      expect(readFileSync(path.join(f.link, 'SKILL.md'), 'utf8')).toBe('foreign')
      expect(readlinkSync(path.join(f.home, '.agents/skills/wherdr'))).toBe(path.join(f.home, 'missing'))
    })

    it('creates no agent folders or managed copy without an installed agent', () => {
      const f = fixture(mode)
      f.run()
      for (const name of ['.claude', '.agents', 'wherdr']) expect(existsSync(path.join(f.home, name))).toBe(false)
    })
  })
}

it('adopts legacy plugin copies but leaves unrelated managed-path content alone', () => {
  const f = fixture('plugin-native')
  mkdirSync(f.copy, { recursive: true })
  writeFileSync(path.join(f.copy, 'SKILL.md'), 'foreign copy')
  mkdirSync(path.dirname(f.link), { recursive: true })
  f.run()
  expect(readFileSync(path.join(f.copy, 'SKILL.md'), 'utf8')).toBe('foreign copy')
  expect(existsSync(f.link)).toBe(false)
  symlinkSync(f.copy, f.link)
  f.run()
  expect(readFileSync(path.join(f.copy, 'SKILL.md'), 'utf8')).toBe(readFileSync(f.source, 'utf8'))
  execFileSync('sh', [path.join(f.root, 'bin/lib/install-skill.sh'), 'uninstall'], { env: f.env })
  expect(existsSync(f.link)).toBe(false)
})

it('silently ignores an unwritable destination and respects a custom Claude directory', () => {
  const f = fixture('npm')
  const claude = path.join(f.home, 'custom-claude')
  mkdirSync(claude)
  const blocked = path.join(f.home, 'blocked')
  writeFileSync(blocked, 'file, not directory')
  const helper = path.join(f.root, 'bin/lib/install-skill.sh')
  expect(execFileSync('sh', [helper], { env: { ...f.env, CLAUDE_CONFIG_DIR: claude, WHERDR_DIR: blocked }, encoding: 'utf8' })).toBe('')
  execFileSync('sh', [helper], { env: { ...f.env, CLAUDE_CONFIG_DIR: claude } })
  expect(readlinkSync(path.join(claude, 'skills/wherdr'))).toBe(f.copy)
  expect(existsSync(path.join(f.home, '.claude'))).toBe(false)
})

// The CLI removes the wherdr 2 skill once, then starts as usual.
function legacySkill() {
  const f = fixture('npm')
  mkdirSync(path.join(f.home, '.claude'))
  mkdirSync(path.join(f.home, '.codex'))
  execFileSync('sh', [path.join(f.root, 'bin/lib/install-skill.sh'), 'install'], { env: f.env })
  expect(readlinkSync(f.link)).toBe(f.copy)
  return f
}
const removed = (f: ReturnType<typeof fixture>) => {
  for (const p of [f.link, path.join(f.home, '.agents/skills/wherdr'), f.copy]) expect(existsSync(p)).toBe(false)
}

it('removes the 2.x skill and its links, then starts the CLI server', () => {
  const f = legacySkill()
  mkdirSync(path.join(f.root, '.output/server'), { recursive: true })
  writeFileSync(path.join(f.root, '.output/server/index.mjs'), "process.stdout.write('fixture server started\\n')")
  const result = spawnSync(process.execPath, [path.join(f.root, 'bin/wherdr.mjs'), 'run', '--port', '7699'], { env: f.env, encoding: 'utf8', timeout: 10000 })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('fixture server started')
  expect(result.stderr).toBe('')
  removed(f)
})

it('does not follow a foreign symlink at the stable managed copy', () => {
  const f = fixture('plugin-native')
  mkdirSync(path.join(f.home, '.claude'))
  const foreign = path.join(f.home, 'foreign')
  mkdirSync(foreign)
  writeFileSync(path.join(foreign, 'SKILL.md'), 'foreign')
  mkdirSync(path.dirname(f.copy), { recursive: true })
  symlinkSync(foreign, f.copy)
  f.run()
  expect(readFileSync(path.join(foreign, 'SKILL.md'), 'utf8')).toBe('foreign')
  expect(existsSync(f.link)).toBe(false)
})

for (const args of [['start'], ['service', 'install']]) {
  it(`removes the 2.x skill before ${args.join(' ')} checks its prerequisites`, () => {
    const f = legacySkill()
    const result = spawnSync(process.execPath, [path.join(f.root, 'bin/wherdr.mjs'), ...args], { env: f.env, encoding: 'utf8', timeout: 10000 })
    expect(result.status).toBe(1)
    removed(f)
  })
}

it('leaves a foreign skill alone and installs none', () => {
  const f = fixture('npm')
  mkdirSync(f.link, { recursive: true })
  writeFileSync(path.join(f.link, 'SKILL.md'), 'foreign')
  spawnSync(process.execPath, [path.join(f.root, 'bin/wherdr.mjs'), 'start'], { env: f.env, encoding: 'utf8', timeout: 10000 })
  expect(readFileSync(path.join(f.link, 'SKILL.md'), 'utf8')).toBe('foreign')
  expect(existsSync(f.copy)).toBe(false)
})

it.skipIf(process.platform !== 'linux')('keeps a custom Claude directory in the generated login service environment', () => {
  const f = fixture('npm')
  const claude = path.join(f.home, 'custom-claude')
  mkdirSync(claude)
  mkdirSync(path.join(f.root, '.output/server'), { recursive: true })
  writeFileSync(path.join(f.root, '.output/server/index.mjs'), '')
  // Refuse activation, so no real service or server is started; keep a copy of
  // the unit it was asked to enable (a failed install removes it).
  writeFileSync(path.join(f.home, 'tools/systemctl'), `#!/bin/sh
case "$*" in '--user enable --now skill-test.service') cp "$XDG_CONFIG_HOME/systemd/user/skill-test.service" "$HOME/unit.seen"; exit 1 ;; esac
exit 0
`, { mode: 0o755 })
  const result = spawnSync(process.execPath, [path.join(f.root, 'bin/wherdr.mjs'), 'service', 'install', '--port', '7699'], {
    env: { ...f.env, CLAUDE_CONFIG_DIR: claude, WHERDR_SERVICE_NAME: 'skill-test', XDG_CONFIG_HOME: path.join(f.home, '.config') }, encoding: 'utf8', timeout: 10000,
  })
  expect(result.stderr).toContain('enable --now failed')
  const unit = readFileSync(path.join(f.home, 'unit.seen'), 'utf8')
  expect(unit).toContain(`CLAUDE_CONFIG_DIR=${claude}`)
  expect(existsSync(path.join(f.home, '.config/systemd/user/skill-test.service'))).toBe(false)
})


it.skipIf(process.platform !== 'linux')('normalizes a relative Claude config and preserves skill opt-out in the login service', () => {
  const f = fixture('npm')
  mkdirSync(path.join(f.root, '.output/server'), { recursive: true })
  writeFileSync(path.join(f.root, '.output/server/index.mjs'), '')
  const tools = path.join(f.home, 'tools')
  writeFileSync(path.join(tools, 'systemctl'), '#!/bin/sh\ncase "$*" in "--user enable --now skill-test.service") cp "$XDG_CONFIG_HOME/systemd/user/skill-test.service" "$HOME/unit.seen"; exit 1 ;; esac\nexit 0\n', { mode: 0o755 })
  const result = spawnSync(process.execPath, [path.join(f.root, 'bin/wherdr.mjs'), 'service', 'install', '--port', '7699'], {
    env: { ...f.env, CLAUDE_CONFIG_DIR: '.custom-claude', WHERDR_SKILL: 'off', WHERDR_SERVICE_NAME: 'skill-test', XDG_CONFIG_HOME: path.join(f.home, '.config') },
    encoding: 'utf8', timeout: 10000,
  })
  // Refuse activation after the unit is written; no real service is started.
  const unit = readFileSync(path.join(f.home, 'unit.seen'), 'utf8')
  expect(unit).toContain(`CLAUDE_CONFIG_DIR=${f.home}/.custom-claude`)
  expect(unit).toContain('WHERDR_SKILL=off')
  expect(existsSync(f.copy)).toBe(false)
  expect(result.stderr).toContain('enable --now failed')
})


for (const mode of ['plugin-native']) {
  it(`${mode}: WHERDR_SKILL=off neither installs nor refreshes`, () => {
    const f = fixture(mode)
    mkdirSync(path.join(f.home, '.claude'))
    const disabled = { ...f.env, WHERDR_SKILL: 'off' }
    Object.assign(f.env, disabled)
    f.run()
    expect(existsSync(f.copy)).toBe(false)
    Object.assign(f.env, { WHERDR_SKILL: '' })
    f.run()
    const installed = readFileSync(path.join(f.copy, 'SKILL.md'), 'utf8')
    writeFileSync(f.source, 'a new release')
    Object.assign(f.env, disabled)
    f.run()
    expect(readFileSync(path.join(f.copy, 'SKILL.md'), 'utf8')).toBe(installed)
  })
}


for (const mode of ['plugin-native']) {
  it(`${mode}: automatic refresh preserves uninstall until explicit installation`, () => {
    const f = fixture(mode)
    mkdirSync(path.join(f.home, '.claude'))
    f.run()
    execFileSync('sh', [path.join(f.root, 'bin/lib/install-skill.sh'), 'uninstall'], { env: f.env })
    const script = 'scripts/herdr-plugin.sh'
    execFileSync('sh', [path.join(f.root, script), 'skill', 'refresh'], { env: f.env })
    expect(existsSync(f.link)).toBe(false)
    expect(existsSync(f.copy)).toBe(false)
    f.run()
    expect(readFileSync(path.join(f.link, 'SKILL.md'), 'utf8')).toBe(readFileSync(f.source, 'utf8'))
  })
}
