import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { hasCommands } from './helpers/commands'

const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
for (const job of ['package', 'publish-release']) {
  it.skipIf(!hasCommands('bash') || (job === 'package' && !hasCommands('sha256sum')))(`${job} refuses missing drafts/notes and never generates release notes`, () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-draft-'))
    try {
      const bin = path.join(home, 'bin')
      mkdirSync(bin)
      cpSync('scripts', path.join(home, 'scripts'), { recursive: true })
      writeFileSync(path.join(home, 'wherdr-1.3.3.tgz'), 'archive')
      writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  'release view '*)
    [ "$DRAFT_EXISTS" = 1 ] || exit 1
    case "$*" in
      *'--json isDraft'*) echo "$IS_DRAFT" ;;
      *'--json body'*) printf '%s' "$DRAFT_NOTES" ;;
    esac ;;
  *) printf '%s\\n' "$*" >> "$HOME/mutations" ;;
esac
`, { mode: 0o755 })
      const name = job === 'package' ? 'Attach package to draft' : 'Publish without advancing the legacy update channel'
      const section = workflow.split(`      - name: ${name}\n`)[1]!
      const script = section.split('        run: |\n')[1]!.split('\n\n')[0]!
        .split('\n').map(line => line.replace(/^          /, '')).join('\n')
      for (const scenario of [
        { exists: '0', draft: 'true', notes: 'Reviewed notes', ok: false },
        { exists: '1', draft: 'false', notes: 'Reviewed notes', ok: false },
        { exists: '1', draft: 'true', notes: '', ok: false },
        { exists: '1', draft: 'true', notes: ' \n\t ', ok: false },
        { exists: '1', draft: 'true', notes: 'See CHANGELOG.md', ok: false },
        { exists: '1', draft: 'true', notes: '## Fixed\nDownloads now work correctly on supported Node versions. Temporary download links are released after the browser saves the file.\n\n[Full changelog](https://github.com/example/wherdr/blob/v1.3.3/CHANGELOG.md)', ok: true },
      ]) {
        rmSync(path.join(home, 'mutations'), { force: true })
        const run = spawnSync('bash', ['-e', '-c', script], { cwd: home, encoding: 'utf8', env: {
          ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GITHUB_REF_NAME: 'v1.3.3',
          GITHUB_REPOSITORY: 'example/wherdr', DRAFT_EXISTS: scenario.exists,
          IS_DRAFT: scenario.draft, DRAFT_NOTES: scenario.notes,
        } })
        expect(run.status === 0, run.stderr).toBe(scenario.ok)
        let mutations = ''
        try { mutations = readFileSync(path.join(home, 'mutations'), 'utf8') } catch {}
        if (!scenario.ok) expect(mutations).toBe('')
        else expect(mutations).toContain(job === 'package' ? 'release upload' : 'release edit')
        expect(mutations).not.toMatch(/release create|generate-notes/)
      }
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
}

const npmWorkflow = readFileSync('.github/workflows/npm.yml', 'utf8')
function npmStep(name: string) {
  const section = npmWorkflow.split(`      - name: ${name}\n`)[1]!.split('\n      - ')[0]!
  const run = section.split('        run: ')[1]!
  return run.startsWith('|\n')
    ? run.slice(2).split('\n').map(line => line.replace(/^          /, '')).join('\n')
    : run.trim()
}

it('uses one release tag for dispatch, checkout and concurrency, preserving OIDC publishing', () => {
  expect(npmWorkflow).toMatch(/workflow_dispatch:\s+inputs:\s+version:/)
  expect(npmWorkflow).toMatch(/version:\s+description:.*\n\s+required: true\n\s+type: string/)
  expect(npmWorkflow).toContain('RELEASE_TAG: ${{ inputs.version }}')
  expect(npmWorkflow).toContain('group: npm-${{ inputs.version }}')
  expect(npmWorkflow).toContain('cancel-in-progress: false')
  expect(npmWorkflow).toContain('ref: refs/tags/${{ env.RELEASE_TAG }}')
  expect(npmWorkflow.indexOf('name: Validate release tag')).toBeLessThan(npmWorkflow.indexOf('uses: actions/checkout'))
  expect(npmWorkflow).toContain('GH_REPO: ${{ github.repository }}')
  expect(npmWorkflow).toContain('id-token: write')
  expect(npmWorkflow).toContain('runs-on: ubuntu-24.04')
  expect(npmWorkflow).not.toContain('GITHUB_REF_NAME')
  expect(npmWorkflow).not.toMatch(/^\s+environment:/m)
})

// A tag push used to start npm.yml beside release.yml, before the release had its package.
it('starts npm only from release.yml, after publish-release, or by hand', () => {
  const on = npmWorkflow.split('\non:\n')[1]!.split('\nenv:\n')[0]!
  expect(on.split('\n')[0]).toBe('  workflow_dispatch:')
  expect(on).not.toMatch(/^  (push|release|workflow_run):/m)
  const job = workflow.split('\n  npm:\n')[1]!.split('\n\n')[0]!
  expect(job).toContain('    needs: publish-release\n')
  expect(job).toContain('      actions: write')
  expect(job).toContain('run: gh workflow run npm.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" -f version="$GITHUB_REF_NAME"')
  // Homebrew failing must not hold npm back: the dispatch depends on publish-release only.
  expect(workflow.indexOf('\n  publish-release:\n')).toBeLessThan(workflow.indexOf('\n  npm:\n'))
})

it('skips every publishing step once the version is on npm', () => {
  const steps = npmWorkflow.split('\n    steps:\n')[1]!.split('\n      - ').slice(1)
  const after = steps.slice(steps.findIndex(step => step.includes('id: registry')) + 1)
  expect(after.length).toBeGreaterThan(0)
  for (const step of after) expect(step).toContain("if: steps.registry.outputs.published == 'false'")
})

it.skipIf(!hasCommands('bash'))('reads the registry: published skips, missing publishes, errors fail', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-npm-registry-'))
  try {
    writeFileSync(path.join(home, 'curl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/requests"
printf '%s' "$HTTP_STATUS"
`, { mode: 0o755 })
    for (const [status, ok, published] of [['200', true, 'true'], ['404', true, 'false'], ['500', false, ''], ['000', false, '']] as const) {
      rmSync(path.join(home, 'requests'), { force: true })
      const output = path.join(home, 'output')
      writeFileSync(output, '')
      const run = spawnSync('bash', ['-e', '-c', npmStep('Check npm registry')], {
        cwd: home, encoding: 'utf8', env: {
          ...process.env, HOME: home, PATH: `${home}:${process.env.PATH}`,
          RELEASE_TAG: 'v1.3.3', HTTP_STATUS: status, GITHUB_OUTPUT: output,
        },
      })
      expect(run.status === 0, run.stderr).toBe(ok)
      expect(readFileSync(path.join(home, 'requests'), 'utf8')).toContain('https://registry.npmjs.org/wherdr/1.3.3')
      expect(readFileSync(output, 'utf8')).toBe(published ? `published=${published}\n` : '')
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it.skipIf(!hasCommands('bash'))('rejects invalid or missing releases before checkout', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-npm-tag-'))
  try {
    writeFileSync(path.join(home, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/requests"
[ "$RELEASE_EXISTS" = 1 ]
`, { mode: 0o755 })
    for (const [tag, exists, ok] of [
      ['v1.3.3', '1', true], ['v2.0.0', '1', true], ['v1.3.3', '0', false],
      ['main', '1', false], ['1.3.3', '1', false], ['v1.3.3-beta.1', '1', false],
      ['v1.3', '1', false], ['v1.3.3/extra', '1', false], ['v1.3.3\necho injected', '1', false],
      ['$(touch injected)', '1', false], ['', '1', false],
    ] as const) {
      rmSync(path.join(home, 'requests'), { force: true })
      const run = spawnSync('bash', ['-e', '-c', npmStep('Validate release tag')], {
        cwd: home, encoding: 'utf8', env: {
          ...process.env, HOME: home, PATH: `${home}:${process.env.PATH}`,
          RELEASE_TAG: tag, RELEASE_EXISTS: exists, GH_REPO: 'example/wherdr',
        },
      })
      expect(run.status === 0, run.stderr).toBe(ok)
      let requests = ''
      try { requests = readFileSync(path.join(home, 'requests'), 'utf8') } catch {}
      expect(requests).toBe(tag === 'v1.3.3' || tag === 'v2.0.0'
        ? `release view ${tag} --json tagName --jq .tagName\n` : '')
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// Execute the real CI shell and checksum verifier only when they are installed.
it.skipIf(!hasCommands('bash', 'sha256sum'))('checks tagged versions and downloads and publishes the requested local archive from main', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-npm-publish-'))
  try {
    const bin = path.join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
[ "$*" = 'release download v1.3.3 --pattern wherdr-1.3.3.tgz* --dir package --clobber' ] || exit 1
mkdir -p package
printf archive > package/wherdr-1.3.3.tgz
printf '%s  wherdr-1.3.3.tgz\\n' '${createHash('sha256').update('archive').digest('hex')}' > package/wherdr-1.3.3.tgz.sha256
`, { mode: 0o755 })
    writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/publish-args"
`, { mode: 0o755 })
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
      RELEASE_TAG: 'v1.3.3', GITHUB_REF_NAME: 'main', GH_REPO: 'example/wherdr' }
    for (const [pkg, plugin, ok] of [
      ['1.3.3', '1.3.3', true], ['1.3.2', '1.3.3', false], ['1.3.3', '1.3.2', false],
    ] as const) {
      writeFileSync(path.join(home, 'package.json'), JSON.stringify({ version: pkg }))
      writeFileSync(path.join(home, 'herdr-plugin.toml'), `version = "${plugin}"\n`)
      const run = spawnSync('bash', ['-e', '-c', npmStep('Versions match the tag')], { cwd: home, encoding: 'utf8', env })
      expect(run.status === 0, run.stderr).toBe(ok)
    }
    const download = spawnSync('bash', ['-e', '-c', npmStep('Download the release package')], { cwd: home, encoding: 'utf8', env })
    expect(download.status, download.stderr).toBe(0)
    const publish = spawnSync('bash', ['-e', '-c', npmStep('Publish')], { cwd: home, encoding: 'utf8', env })
    expect(publish.status, publish.stderr).toBe(0)
    expect(readFileSync(path.join(home, 'publish-args'), 'utf8').trim().split('\n')).toEqual([
      'publish', './package/wherdr-1.3.3.tgz', '--provenance', '--access', 'public',
    ])
  } finally { rmSync(home, { recursive: true, force: true }) }
})
