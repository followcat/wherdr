import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { changedFiles, domains, inventory, literalPattern, parseChanges, select } from '../scripts/test-affected.mjs'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-')); dirs.push(cwd)
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  mkdirSync(join(cwd, 'shared'))
  writeFileSync(join(cwd, 'shared/reference old.ts'), 'export const value = 1\n')
  git('add', '.'); git('commit', '-qm', 'Fixture'); git('branch', 'base')
  return { cwd, git }
}
const available = ['tests/reference.test.ts', 'tests/components/Composer.test.ts', 'tests/e2e/reference.spec.ts', 'tests/e2e/core-smoke.spec.ts']
describe('affected test selector', () => {
  it('parses NUL names including both sides of renames and copies', () => {
    expect(parseChanges('R100\0old name.ts\0new name.ts\0D\0deleted.ts\0M\0space name.ts\0')).toEqual(['old name.ts', 'new name.ts', 'deleted.ts', 'space name.ts'])
  })
  it('collects committed renames, deletions, staged, unstaged and new files', () => {
    const { cwd, git } = repo()
    git('mv', 'shared/reference old.ts', 'shared/reference new.ts'); git('commit', '-qm', 'Rename')
    writeFileSync(join(cwd, 'staged.ts'), 'staged'); git('add', 'staged.ts')
    writeFileSync(join(cwd, 'shared/reference new.ts'), 'unstaged')
    writeFileSync(join(cwd, 'new file.ts'), 'new')
    const changes = changedFiles('base', cwd)
    expect(changes.warning).toBeUndefined()
    expect(changes.files).toEqual(['new file.ts', 'shared/reference new.ts', 'shared/reference old.ts', 'staged.ts'])
    rmSync(join(cwd, 'shared/reference new.ts'))
    expect(changedFiles('base', cwd).files).toContain('shared/reference new.ts')
  })
  it('uses merge-base rather than the target tip', () => {
    const { cwd, git } = repo()
    const head = git('rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'target-only.ts'), 'target')
    git('add', '.'); git('commit', '-qm', 'Target change'); git('branch', '-f', 'base')
    git('reset', '--hard', head)
    expect(changedFiles('base', cwd).files).toEqual([])
  })
  it('covers old and new domains even when the old path no longer exists', () => {
    const plan = select(['shared/reference old.ts', 'app/components/Terminal.vue', 'app/components/MachineBar.vue'], available.concat('tests/terminalSize.test.ts', 'tests/e2e/core-machines.spec.ts'), undefined)
    expect(Object.keys(plan.domains)).toEqual(['references', 'terminal', 'machines'])
    expect(Object.keys(plan.e2e)).toContain('tests/e2e/core-machines.spec.ts')
    expect(Object.keys(plan.tests)).toContain('tests/reference.test.ts')
    expect(Object.keys(plan.tests)).toContain('tests/terminalSize.test.ts')
  })
  it('routes frozen-copy changes to their own domain and spec', () => {
    const plan = select(['app/components/TerminalCopyLayer.vue', 'app/utils/screenSpans.ts'], available.concat('tests/terminalCopy.test.ts', 'tests/e2e/terminal-copy.spec.ts'), undefined)
    expect(Object.keys(plan.domains)).toEqual(['terminal', 'copy'])
    expect(Object.keys(plan.e2e)).toContain('tests/e2e/terminal-copy.spec.ts')
    expect(Object.keys(plan.tests)).toContain('tests/terminalCopy.test.ts')
  })
  it.each(['app/components/TerminalView.vue', 'app/composables/useTerminal.ts', 'app/components/AgentView.vue', 'app/components/InteractiveTerminal.vue'])('selects the copy journey for its %s integration path', file => {
    const plan = select([file], available.concat('tests/terminalCopy.test.ts', 'tests/e2e/terminal-copy.spec.ts'), undefined)
    expect(Object.keys(plan.domains)).toContain('copy')
    expect(Object.keys(plan.e2e)).toContain('tests/e2e/terminal-copy.spec.ts')
  })
  it.each([
    'app/utils/terminalTouch.ts', 'app/utils/terminalWheel.ts', 'app/utils/smoothTouch.ts',
    'app/components/TerminalView.vue', 'app/composables/useTerminal.ts',
  ])('selects the touch-scroll journey for its %s integration path', file => {
    const plan = select([file], available.concat('tests/components/TerminalTouchBeta.test.ts', 'tests/e2e/terminal-touch.spec.ts'), undefined)
    expect(Object.keys(plan.domains)).toContain('touch-scroll')
    expect(Object.keys(plan.e2e)).toContain('tests/e2e/terminal-touch.spec.ts')
  })
  it.each([
    'app/utils/terminalModifiers.ts', 'app/utils/keybarKeys.ts', 'app/utils/phoneKeys.ts',
    'app/utils/keybarOrder.ts', 'app/components/PhoneKeybar.vue', 'app/components/Keybar.vue',
    'app/utils/terminalKeys.ts', 'app/composables/useTerminal.ts', 'server/utils/coreInput.ts', 'server/utils/coreTerm.ts',
  ])('selects the virtual-keys journey for its %s integration path', file => {
    const plan = select([file], available.concat('tests/terminalModifiers.test.ts', 'tests/e2e/terminal-keys.spec.ts'), undefined)
    expect(Object.keys(plan.domains)).toContain('keys')
    expect(Object.keys(plan.e2e)).toContain('tests/e2e/terminal-keys.spec.ts')
  })
  it('routes phone chrome changes to the phone-ux journey', () => {
    const plan = select(['app/components/Composer.vue', 'app/components/PhoneIdentity.vue'], available.concat('tests/components/ComposerFocus.test.ts', 'tests/e2e/phone-terminal-ux.spec.ts'), undefined)
    expect(Object.keys(plan.domains)).toContain('phone-ux')
    expect(Object.keys(plan.e2e)).toContain('tests/e2e/phone-terminal-ux.spec.ts')
    expect(Object.keys(plan.tests)).toContain('tests/components/ComposerFocus.test.ts')
  })
  it.each(['app/components/AppSheet.vue', 'app/components/MenuSheet.vue', 'app/composables/useViewport.ts', 'app/utils/viewMode.ts'])('selects the phone-ux journey for its %s integration path', file => {
    const plan = select([file], available.concat('tests/components/PhoneIdentity.test.ts', 'tests/e2e/phone-terminal-ux.spec.ts'), undefined)
    expect(Object.keys(plan.domains)).toContain('phone-ux')
    expect(Object.keys(plan.e2e)).toContain('tests/e2e/phone-terminal-ux.spec.ts')
  })
  it('falls back visibly for an unknown file and a missing base', () => {
    const plan = select(['unknown source.ts'], available, undefined)
    expect(plan.broad).toBe(true)
    expect(Object.keys(plan.tests)).toHaveLength(2)
    expect(Object.keys(plan.e2e)).toEqual(['tests/e2e/core-smoke.spec.ts'])
    const { cwd } = repo()
    const changes = changedFiles('missing-branch', cwd)
    expect(changes.warning).toMatch(/merge-base/)
    expect(select([], available, changes.warning).broad).toBe(true)
  })
  it('does not run a browser for documentation or an unchanged tree', () => {
    for (const files of [[], ['README.md', 'docs/guide.md']]) {
      const plan = select(files, available, undefined)
      expect(plan.tests).toEqual({}); expect(plan.e2e).toEqual({})
    }
  })
  it('runs changed specs explicitly and falls back for deleted tests', () => {
    const plan = select(['tests/e2e/reference.spec.ts', 'tests/components/Composer.test.ts'], available, undefined)
    expect(Object.keys(plan.e2e)).toEqual(['tests/e2e/reference.spec.ts'])
    expect(Object.keys(plan.tests)).toEqual(['tests/components/Composer.test.ts'])
    expect(select(['tests/deleted.test.ts'], available, undefined).broad).toBe(true)
  })
  it('escapes Playwright regex filters, including spaces and brackets', () => {
    const path = 'tests/e2e/a [b]+.spec.ts'
    const pattern = new RegExp(`${literalPattern(path)}$`)
    expect(pattern.test(path)).toBe(true)
    expect(pattern.test('tests/e2e/a bbbXspecXts')).toBe(false)
  })
  it('passes a changed test with spaces as one argument without a browser or shell', () => {
    const { cwd } = repo()
    mkdirSync(join(cwd, 'tests'))
    writeFileSync(join(cwd, 'tests/space name.test.ts'), '// fixture')
    const tools = mkdtempSync(join(tmpdir(), 'affected-tools-')); dirs.push(tools)
    const trace = join(tools, 'trace.json')
    writeFileSync(join(tools, 'flock'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const r=spawnSync(process.argv[3],process.argv.slice(4),{stdio:'inherit'});process.exit(r.status ?? 1)`, { mode: 0o755 })
    writeFileSync(join(tools, 'npx'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.AFFECTED_TRACE,JSON.stringify(process.argv.slice(2)))`, { mode: 0o755 })
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/test-affected.mjs', import.meta.url)), '--base', 'base'], {
      cwd, encoding: 'utf8', env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, AFFECTED_TRACE: trace },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(trace, 'utf8'))).toEqual(['--no-install', 'vitest', 'run', 'tests/space name.test.ts'])
    expect(result.stdout).toContain('Changed test: run explicitly.')
  })
  it('prints a docs-only dry run without spawning test tools', () => {
    const { cwd } = repo()
    mkdirSync(join(cwd, 'tests'))
    writeFileSync(join(cwd, 'README.md'), '# Fixture')
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/test-affected.mjs', import.meta.url)), '--base', 'base', '--dry-run'], { cwd, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Documentation only: no JS tests or browser required.')
    expect(result.stdout).toContain('"project": "chromium-phone"')
  })
  it('refuses a selection covering the entire Playwright suite before building', () => {
    const { cwd } = repo()
    mkdirSync(join(cwd, 'tests/e2e'), { recursive: true })
    for (const name of ['first', 'second']) writeFileSync(join(cwd, `tests/e2e/${name}.spec.ts`), '// fixture')
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/test-affected.mjs', import.meta.url)), '--base', 'base'], { cwd, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Refusing the full Playwright suite locally')
  })
  it('keeps every reviewed domain connected to existing tests and journeys', () => {
    const files = inventory()
    for (const domain of domains) {
      expect(files.some(p => p.endsWith('.test.ts') && domain.tests.test(p)), domain.name).toBe(true)
      for (const name of domain.e2e) expect(files).toContain(`tests/e2e/${name}.spec.ts`)
    }
  })
})
