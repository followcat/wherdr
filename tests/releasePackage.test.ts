import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { driverFor, realIo } from '../bin/lib/updater.mjs'
import { ready, readiness, promote } from '../scripts/release-ready.mjs'

it('downloads a local release, verifies before extraction, and restores the previous plugin', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wherdr-release-'))
  const pkg = path.join(home, 'package')
  mkdirSync(path.join(pkg, '.output/server'), { recursive: true })
  mkdirSync(path.join(pkg, 'skills/wherdr'), { recursive: true })
  mkdirSync(path.join(pkg, 'bin/lib'), { recursive: true })
  writeFileSync(path.join(pkg, '.output/server/index.mjs'), '// built server')
  writeFileSync(path.join(pkg, 'skills/wherdr/SKILL.md'), 'release skill')
  writeFileSync(path.join(pkg, 'package.json'), '{"version":"1.3.3"}')
  const tgz = path.join(home, 'release.tgz')
  execFileSync('tar', ['-czf', tgz, '-C', home, 'package'])
  const data = readFileSync(tgz)
  const sha = createHash('sha256').update(data).digest('hex')
  let corrupt = false
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/npm/')) { res.writeHead(404); res.end('missing'); return }
    res.end(req.url?.endsWith('.sha256') ? `${corrupt ? '0'.repeat(64) : sha}  wherdr-1.3.3.tgz\n` : data)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const root = path.join(home, 'app')
    mkdirSync(root)
    writeFileSync(path.join(root, 'previous'), 'old')
    const plan = { kind: 'plugin', root, dir: home, to: '1.3.3', releaseBase: base, runtime: process.execPath }
    const driver = driverFor(plan, realIo(plan))
    await driver.install()
    expect(readFileSync(`${root}.new/skills/wherdr/SKILL.md`, 'utf8')).toBe('release skill')
    await driver.activate()
    await driver.rollback()
    expect(readFileSync(path.join(root, 'previous'), 'utf8')).toBe('old')
    corrupt = true
    await expect(driver.install()).rejects.toThrow('SHA-256 mismatch')
    expect(existsSync(`${root}.new`)).toBe(false)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(home, { recursive: true, force: true })
  }
})

it('advances the legacy channel only after npm latest, the tarball, and Homebrew are ready', async () => {
  for (const missing of ['metadata', 'tag', 'tarball', 'formula', 'none']) {
    const fetcher = async (url: string) => ({
      ok: !((url.endsWith('/latest') && missing === 'metadata') || (url.endsWith('.tgz') && missing === 'tarball')),
      json: async () => ({ version: missing === 'tag' ? '1.3.2' : '1.3.3' }),
      text: async () => missing === 'formula' ? 'old' : 'url "https://github.com/example/wherdr/releases/download/v1.3.3/wherdr-1.3.3.tgz"',
    })
    expect(await ready('1.3.3', fetcher, 'example/wherdr')).toBe(missing === 'none')
  }
})

it('reports npm and Homebrew blockers separately, ignores 3.x and does not rewrite an already-current latest', async () => {
  const request = async () => ({ ok: false, json: async () => ({}), text: async () => '' })
  const result = await readiness('1.3.3', request, 'example/wherdr')
  expect(result.ready).toBe(false)
  expect(result.missing.join('\n')).toMatch(/npm latest/)
  expect(result.missing.join('\n')).toMatch(/npm archive/)
  expect(result.missing.join('\n')).toMatch(/Homebrew formula.*bump-homebrew/)
  const calls: string[] = []
  const run = (_cmd: string, args: string[]) => {
    calls.push(args.join(' '))
    return JSON.stringify(args[1].endsWith('/latest') ? { tag_name: 'v1.3.3' } : [{ tag_name: 'v3.0.0' }, { tag_name: 'v1.3.3' }])
  }
  const logs: string[] = []
  await promote({ repo: 'example/wherdr', request, run, log: (line: string) => logs.push(line) })
  expect(calls).toHaveLength(2)
  expect(calls.some(call => call.includes('release edit'))).toBe(false)
  expect(logs.join('\n')).toContain('already at v1.3.3')
})
