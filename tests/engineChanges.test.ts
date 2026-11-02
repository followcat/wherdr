import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { engineDecision, needsEngine } from '../scripts/engine-changes.mjs'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
it('skips ordinary UI changes and selects engine inputs and mixed PRs', () => {
  expect(needsEngine(['app/components/Composer.vue', 'docs/devices.md'])).toBe(false)
  for (const path of ['engine/Cargo.lock', 'engine/deleted.rs', 'packages/board-linux-x64/package.json',
    'bin/wherdr-board.mjs', 'bin/lib/userpath.mjs', 'scripts/pack-output.mjs', 'package-lock.json',
    '.github/workflows/ci.yml', '.github/workflows/engine-ci.yml', '.github/workflows/develop-prerelease.yml',
    'server/utils/projectsTasks.ts', 'server/utils/boardLinks.ts', 'shared/projectsPlugin.ts',
    'skills/wherdr-board/SKILL.md', 'tests/boardContract.test.ts']) {
    expect(needsEngine(['app/app.vue', path]), path).toBe(true)
  }
})
it('selects manual runs, missing history, new branches and unknown events conservatively', () => {
  for (const [event, before] of [['workflow_dispatch', ''], ['push', '000000'], ['push', 'missing'], ['pull_request', ''], ['unknown', '']]) {
    expect(engineDecision(event, before, tmpdir())).toBe(true)
  }
})
it('checks both sides of real moves into, within and out of engine, including unusual names', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-filter-')); dirs.push(cwd)
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  }
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  mkdirSync(join(cwd, 'engine'))
  writeFileSync(join(cwd, 'outside.rs'), 'fixture')
  git('add', '.'); git('commit', '-qm', 'Fixture')
  for (const [from, to] of [['outside.rs', 'engine/space name.rs'], ['engine/space name.rs', 'engine/line\nname.rs'], ['engine/line\nname.rs', 'outside.rs']]) {
    const before = git('rev-parse', 'HEAD')
    git('mv', from, to); git('commit', '-qm', 'Move fixture')
    expect(engineDecision('push', before, cwd)).toBe(true)
    expect(engineDecision('pull_request', '', cwd)).toBe(true)
  }
  const before = git('rev-parse', 'HEAD')
  writeFileSync(join(cwd, 'ui.ts'), 'fixture'); git('add', '.'); git('commit', '-qm', 'UI fixture')
  expect(engineDecision('push', before, cwd)).toBe(false)
  expect(engineDecision('pull_request', '', cwd)).toBe(false)
  git('checkout', '-qb', 'base')
  writeFileSync(join(cwd, 'engine/base.rs'), 'base change')
  git('add', '.'); git('commit', '-qm', 'Base engine change')
  git('checkout', '-qb', 'ui', before)
  writeFileSync(join(cwd, 'feature.ts'), 'feature change')
  git('add', '.'); git('commit', '-qm', 'UI feature')
  // Match Actions' synthetic merge commit: first parent is the target branch.
  git('checkout', 'base'); git('merge', '--no-ff', 'ui', '-m', 'PR fixture')
  expect(engineDecision('pull_request', '', cwd)).toBe(false)
  const deletionBase = git('rev-parse', 'HEAD')
  git('rm', 'engine/base.rs'); git('commit', '-qm', 'Delete engine fixture')
  expect(engineDecision('push', deletionBase, cwd)).toBe(true)
})
it('keeps the final check green only for a successful selection and the expected result', () => {
  for (const changes of ['success', 'failure', 'cancelled', 'skipped']) {
    for (const needed of ['true', 'false', '']) {
      for (const engine of ['success', 'failure', 'cancelled', 'skipped', '']) {
        const r = spawnSync('sh', ['scripts/engine-result.sh'], { env: { ...process.env, CHANGES: changes, NEEDED: needed, ENGINE: engine } })
        expect(r.status === 0, `${changes}/${needed}/${engine}`).toBe(changes === 'success' && (needed === 'true' && engine === 'success' || needed === 'false' && engine === 'skipped'))
      }
    }
  }
})
