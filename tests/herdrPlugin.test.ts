// v3 is not a Herdr plugin: `herdr plugin install|update` of this repository and the
// curl installer must stop at once, change nothing, and say how to install v3
// beside v2. A failed plugin build makes Herdr keep the install it had (v2).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO } from '../website/app/utils/site'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')
const GUIDE = `${REPO}/blob/v3/docs/migrate-from-v2.md`

function run(args: string[]) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-v3-stub-'))
  try {
    const result = spawnSync('sh', args, { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })
    return { ...result, files: readdirSync(home) }
  } finally { rmSync(home, { recursive: true, force: true }) }
}

describe('herdr-plugin.toml', () => {
  it('ships the version of the app (bump both on release)', () => {
    expect(read('herdr-plugin.toml').match(/^version = "([^"]*)"$/m)?.[1]).toBe(JSON.parse(read('package.json')).version)
  })

  it('has only a build, which stops with the way to install v3 and changes nothing', () => {
    const manifest = read('herdr-plugin.toml')
    expect(manifest.match(/^\[\[(\w+)\]\]$/gm)).toEqual(['[[build]]'])
    const build = manifest.match(/^command = \["sh", "-c", '''\n([\s\S]*?)'''\]$/m)![1]!
    const result = run(['-c', build])
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('wherdr v3 is not a Herdr plugin, and nothing was changed')
    expect(result.stderr).toContain(GUIDE)
    expect(result.stderr).toContain(`herdr plugin install ${REPO.replace('https://github.com/', '')} --ref 2.x`)
    expect(result.files).toEqual([])
  })
})

describe('website/public/install', () => {
  it('installs nothing and prints how to install v3 beside v2', () => {
    const result = run(['website/public/install'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('wherdr v3 is not installed by this script, and nothing was changed.')
    expect(result.stderr).toContain(`git clone -b v3 ${REPO}.git /tmp/wherdr-setup`)
    expect(result.stderr).toContain('sh /tmp/wherdr-setup/scripts/install-v3-beside-v2.sh --yes')
    expect(result.stderr).toContain(`Guide: ${GUIDE}`)
    expect(result.files).toEqual([])
    expect(read('website/public/install')).not.toMatch(/herdr"? plugin (install|update)/)
  })
})
