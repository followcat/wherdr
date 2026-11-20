import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listClientPlugins } from '../server/utils/clientPlugins'
import { checkPluginSource, installFromGitHub, parsePluginSpec, previewFromGitHub, removeClientPlugin, type GitHub } from '../server/utils/pluginInstall'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
type Node = string | { link: string } | Record<string, unknown>
// A fake GitHub: one repo, a tree per commit, refs pointing at commits.
function fakeGitHub(trees: Record<string, Record<string, Node>>, refs: Record<string, string>, opts: { release?: string, offline?: boolean, behind?: Record<string, string[]> } = {}): GitHub {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
  const missing = () => new Response('{}', { status: 404 })
  const at = (tree: Record<string, Node>, p: string) => p.split('/').filter(Boolean).reduce<Node | undefined>((n, k) => (n && typeof n === 'object' ? (n as Record<string, Node>)[k] : undefined), tree)
  return {
    api: 'https://api.test',
    raw: 'https://raw.test',
    fetch: (async (input: string) => {
      if (opts.offline) throw new TypeError('fetch failed')
      const u = new URL(input)
      const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean)
      if (u.host === 'raw.test') {
        const [, , commit, ...rest] = parts
        const n = trees[commit!] && at(trees[commit!]!, rest.join('/'))
        return typeof n === 'string' ? new Response(n) : missing()
      }
      const [, owner, repo, kind, ...rest] = parts
      if (repo !== 'hello' || owner === 'nobody') return missing()
      if (!kind) return json({ default_branch: 'main' })
      if (kind === 'releases') return opts.release ? json({ tag_name: opts.release }) : missing()
      if (kind === 'commits') return refs[rest.join('/')] ? json({ sha: refs[rest.join('/')] }) : missing()
      if (kind === 'branches') {
        const page = Number(u.searchParams.get('page') || 1)
        return json(Object.keys(refs).filter(r => !/^[0-9a-f]{40}$/.test(r)).slice((page - 1) * 100, page * 100).map(name => ({ name })))
      }
      if (kind === 'tags') return json([])
      // A commit is on a ref at its tip, or among the older commits `behind` lists for it.
      if (kind === 'compare') {
        const [base, head] = rest.join('/').split('...')
        if (!refs[base!]) return missing()
        return json({ status: refs[base!] === head ? 'identical' : opts.behind?.[base!]?.includes(head!) ? 'behind' : 'ahead' })
      }
      const tree = trees[u.searchParams.get('ref')!]
      const dir = tree && at(tree, rest.join('/'))
      if (!dir || typeof dir !== 'object' || 'link' in dir) return missing()
      return json(Object.entries(dir).map(([name, n]) => ({
        name, path: [...rest, name].join('/'), size: typeof n === 'string' ? n.length : 0,
        type: typeof n === 'string' ? 'file' : 'link' in n ? 'symlink' : 'dir',
      })))
    }) as typeof fetch,
  }
}
const plugin = (version = '1.0.0', extra: Record<string, unknown> = {}) => ({
  'manifest.json': JSON.stringify({ name: 'Hello', version, description: 'Says hello.', ...extra }),
  'index.js': 'export default () => {}',
  'README.md': '# Hello',
  'src': { 'index.ts': 'source' },
})

let dir = ''
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wherdr-install-')) })
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }) })

it('reads owner/repo with an optional ref', () => {
  expect(parsePluginSpec('me/hello')).toEqual({ repo: 'me/hello', ref: '' })
  expect(parsePluginSpec('https://github.com/me/hello@v1.0.0')).toEqual({ repo: 'me/hello', ref: 'v1.0.0' })
  expect(parsePluginSpec('me/hello@../x')).toBeNull()
  expect(parsePluginSpec('hello')).toBeNull()
})

describe('install', () => {
  it('previews the latest release at its commit, installs only the plain files with the source', async () => {
    const gh = fakeGitHub({ [A]: plugin() }, { 'v1.0.0': A, 'main': B }, { release: 'v1.0.0' })
    const p = await previewFromGitHub('me/hello', gh, dir)
    expect(p).toMatchObject({ id: 'hello', name: 'Hello', version: '1.0.0', resolved: 'v1.0.0', update: false, source: { repo: 'me/hello', ref: '', commit: A } })
    await expect(fsp.readdir(dir)).resolves.toEqual([])
    await installFromGitHub(p.source, gh, dir)
    expect((await fsp.readdir(path.join(dir, 'hello'))).sort()).toEqual(['.source.json', 'README.md', 'index.js', 'manifest.json'])
    expect(await listClientPlugins(dir)).toEqual([expect.objectContaining({ id: 'hello', source: { repo: 'me/hello', ref: '', commit: A } })])
  })

  it('takes the folder the manifest names, and defaults to the default branch', async () => {
    const gh = fakeGitHub({ [B]: { 'manifest.json': '{"name":"Hello","folder":"dist"}', 'dist': { 'index.js': 'x' } } }, { main: B })
    const p = await previewFromGitHub('me/hello', gh, dir)
    expect(p.resolved).toBe('main')
    await installFromGitHub(p.source, gh, dir)
    expect(await fsp.readFile(path.join(dir, 'hello', 'index.js'), 'utf8')).toBe('x')
  })

  it.each([
    ['a ".." name', { ...plugin(), '..': 'x' }, /Bad file name/],
    ['a link', { ...plugin(), 'evil.js': { link: '/etc/passwd' } }, /Links are not allowed/],
    ['a main file only in a sub-folder', { 'manifest.json': '{"main":"index.js"}', 'lib': { 'index.js': 'x' } }, /index\.js is missing/],
    ['too big', { ...plugin(), 'big.js': 'x'.repeat(5 * 1024 * 1024) }, /too big/],
    ['no manifest', { 'index.js': 'x' }, /No manifest\.json/],
  ])('refuses %s and writes nothing', async (_, tree, why) => {
    const gh = fakeGitHub({ [A]: tree as Record<string, Node> }, { main: A })
    await expect(previewFromGitHub('me/hello@main', gh, dir)).rejects.toThrow(why)
    await expect(installFromGitHub({ repo: 'me/hello', ref: 'main', commit: A }, gh, dir)).rejects.toThrow(why)
    expect(await fsp.readdir(dir)).toEqual([])
  })

  it('refuses an id already installed from somewhere else', async () => {
    await fsp.mkdir(path.join(dir, 'hello'))
    await fsp.writeFile(path.join(dir, 'hello', 'manifest.json'), '{}')
    const gh = fakeGitHub({ [A]: plugin() }, { main: A })
    await expect(previewFromGitHub('me/hello@main', gh, dir)).rejects.toThrow(/already installed from somewhere else/)
    await expect(installFromGitHub({ repo: 'me/hello', ref: 'main', commit: A }, gh, dir)).rejects.toThrow(/somewhere else/)
    expect(await fsp.readdir(path.join(dir, 'hello'))).toEqual(['manifest.json'])
  })

  it('two repositories installing the same id at once: the second one is refused', async () => {
    const gh = fakeGitHub({ [A]: plugin() }, { main: A })
    const res = await Promise.allSettled(['one/hello', 'two/hello'].map(repo => installFromGitHub({ repo, ref: 'main', commit: A }, gh, dir)))
    expect(res.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    expect((await listClientPlugins(dir))[0]!.source!.repo).toBe('one/hello')
  })

  it('refuses a fork\'s commit served under the parent\'s name', async () => {
    const gh = fakeGitHub({ [A]: plugin(), [B]: plugin() }, { main: A, [B]: B })
    await expect(previewFromGitHub(`me/hello@${B}`, gh, dir)).rejects.toThrow(/not on a branch or tag/)
    await expect(installFromGitHub({ repo: 'me/hello', ref: 'main', commit: B }, gh, dir)).rejects.toThrow(/not on main/)
    expect(await fsp.readdir(dir)).toEqual([])
  })

  it('takes a commit given alone that is only on another branch, past the first page', async () => {
    const C = 'c'.repeat(40)
    const others = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`b${i}`, A]))
    // `next` is the 101st branch and holds B below its tip C.
    const gh = fakeGitHub({ [A]: plugin(), [B]: plugin() }, { main: A, ...others, next: C, [B]: B }, { behind: { next: [B] } })
    await expect(previewFromGitHub(`me/hello@${B}`, gh, dir)).resolves.toMatchObject({ source: { commit: B } })
  })

  it('restores a plugin a crash left aside and removes leftover temp folders', async () => {
    await fsp.mkdir(path.join(dir, '.old-hello-0123abcd'))
    await fsp.writeFile(path.join(dir, '.old-hello-0123abcd', 'manifest.json'), '{}')
    await fsp.mkdir(path.join(dir, '.install-hello-89abcdef'))
    const gh = fakeGitHub({ [A]: plugin() }, { main: A })
    // The restored folder has no source: it is someone else's, and stays.
    await expect(installFromGitHub({ repo: 'me/hello', ref: 'main', commit: A }, gh, dir)).rejects.toThrow(/somewhere else/)
    expect(await fsp.readdir(dir)).toEqual(['hello'])
  })

  it('says so for a private repository or no network', async () => {
    await expect(previewFromGitHub('me/private', fakeGitHub({}, {}), dir)).rejects.toThrow(/may be private/)
    await expect(previewFromGitHub('me/hello', fakeGitHub({}, {}, { offline: true }), dir)).rejects.toThrow(/Could not reach GitHub/)
    await expect(installFromGitHub({ repo: 'me/hello', ref: '', commit: A }, fakeGitHub({ [A]: plugin() }, {}, { offline: true }), dir)).rejects.toThrow(/Could not reach/)
    expect(await fsp.readdir(dir)).toEqual([])
  })
})

describe('update and remove', () => {
  it('finds a newer commit, installs it only when asked, then removes the plugin', async () => {
    const refs: Record<string, string> = { main: A }
    const gh = fakeGitHub({ [A]: plugin('1.0.0'), [B]: plugin('1.1.0') }, refs)
    await installFromGitHub({ repo: 'me/hello', ref: 'main', commit: A }, gh, dir)
    expect(await checkPluginSource('hello', gh, dir)).toBeNull()
    refs.main = B
    const u = await checkPluginSource('hello', gh, dir)
    expect(u).toMatchObject({ version: '1.1.0', update: true, source: { repo: 'me/hello', ref: 'main', commit: B } })
    expect((await listClientPlugins(dir))[0]).toMatchObject({ version: '1.0.0', source: { commit: A } })
    await installFromGitHub(u!.source, gh, dir)
    expect((await listClientPlugins(dir))[0]).toMatchObject({ version: '1.1.0', source: { commit: B } })
    expect((await fsp.readdir(dir))).toEqual(['hello'])
    await removeClientPlugin('hello', dir)
    expect(await fsp.readdir(dir)).toEqual([])
  })

  it('refuses to check a plugin copied by hand', async () => {
    await expect(checkPluginSource('hello', fakeGitHub({}, {}), dir)).rejects.toThrow(/not installed from GitHub/)
  })
})
