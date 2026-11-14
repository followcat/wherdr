// File paths in agent replies: which inline code is a path, how it resolves
// against the agent's folder, and the clickable markup in rendered markdown.
import { describe, expect, it, vi } from 'vitest'
import { pathCandidate, posixResolve, resolveAgentPath } from '../shared/filePaths'
import { chatFilesLevel } from '../shared/chatFiles'

// markdown.ts runs in the browser: DOMPurify needs a DOM, `t` is auto-imported.
vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s, addHook: () => {} } }))
;(globalThis as { t?: (s: string) => string }).t = s => s

const HOME = '/home/demo'

describe('pathCandidate', () => {
  it('recognizes absolute, home and relative paths', () => {
    for (const p of [
      '/Users/demo/Documents/test/standup.html',
      '~/project/src/app.ts',
      '~/project/',
      '/tmp/report.pdf',
      './scripts/run.sh',
      '../shared/ids.ts',
      'src/app.ts',
      'app/components/',
      'server/utils/reveal',
      'README.md',
      'package.json',
      'Dockerfile',
      '/Users/demo/My Files/notes.txt',
    ]) expect(pathCandidate(p), p).toBe(p)
  })

  it('drops a trailing line and column', () => {
    expect(pathCandidate('src/app.ts:42')).toBe('src/app.ts')
    expect(pathCandidate('~/project/src/app.ts:42:7')).toBe('~/project/src/app.ts')
  })

  it('ignores code that is not a path', () => {
    for (const c of [
      'console.log', 'npm run build', 'and/or', 'a/b', '/model', '/help', 'w1:p1', 'v1.2.3', '1.5',
      'https://example.com/a.ts', 'git commit -m "x"', 'foo()', 'x => x', '$HOME/a.txt', 'src/*.ts',
      '--flag', '-rf', 'a | b', 'Array.from', '', '/', '~', 'ls -la ~/project', 'rm -rf ~/x',
      'items[0].name', 'process.env', 'obj.key', '{a}/b.ts', 'C:\\Users\\x.txt', '<div>', 'a;b/c.ts',
    ]) expect(pathCandidate(c), c).toBeNull()
  })
})

describe('resolveAgentPath', () => {
  it('expands ~ to the machine home', () => {
    expect(resolveAgentPath('~/project/a.ts', '/home/demo/elsewhere', HOME)).toBe('/home/demo/project/a.ts')
    expect(resolveAgentPath('~', null, HOME)).toBe(HOME)
  })

  it('resolves a relative path against the agent folder', () => {
    expect(resolveAgentPath('src/app.ts', '/home/demo/project', HOME)).toBe('/home/demo/project/src/app.ts')
    expect(resolveAgentPath('../other/x.md', '/home/demo/project', HOME)).toBe('/home/demo/other/x.md')
    expect(resolveAgentPath('./a.ts:12', '/home/demo/project', HOME)).toBe('/home/demo/project/a.ts')
  })

  it('falls back to home when the agent folder is unknown or outside home', () => {
    expect(resolveAgentPath('notes.md', null, HOME)).toBe('/home/demo/notes.md')
    expect(resolveAgentPath('notes.md', '/etc', HOME)).toBe('/home/demo/notes.md')
    expect(resolveAgentPath('notes.md', 'relative/dir', HOME)).toBe('/home/demo/notes.md')
  })

  it('refuses anything outside home', () => {
    for (const p of ['/etc/passwd', '/home/demo2/x', '/home', '../../etc/passwd', '~/../other/x', '/home/demo/../demo2/a']) {
      expect(resolveAgentPath(p, '/home/demo/project', HOME), p).toBeNull()
    }
    expect(resolveAgentPath('a\nb', null, HOME)).toBeNull()
    expect(resolveAgentPath('a\0b', null, HOME)).toBeNull()
    expect(resolveAgentPath('a.ts', null, 'relative')).toBeNull()
  })

  it('accepts the other allowed folders, and the agent folder in one of them', () => {
    expect(resolveAgentPath('/tmp/claude-1000/a.md', null, HOME, [HOME, '/tmp'])).toBe('/tmp/claude-1000/a.md')
    expect(resolveAgentPath('a.md', '/tmp/claude-1000', HOME, [HOME, '/tmp'])).toBe('/tmp/claude-1000/a.md')
    expect(resolveAgentPath('/etc/passwd', null, HOME, [HOME, '/tmp'])).toBeNull()
    expect(resolveAgentPath('../../etc/passwd', '/srv/app', HOME, ['/'])).toBe('/etc/passwd')
  })

  it('defaults to everything unless wherdr is publicly exposed; a saved choice wins', () => {
    expect(chatFilesLevel(null, false)).toBe('all')
    expect(chatFilesLevel(null, true)).toBe('temp')
    expect(chatFilesLevel('bogus', true)).toBe('temp')
    expect(chatFilesLevel('all', true)).toBe('all')
    expect(chatFilesLevel('home', false)).toBe('home')
  })

  it('keeps absolute paths inside home as they are', () => {
    expect(resolveAgentPath('/home/demo/a/./b//c.txt', '/home/demo/project', HOME)).toBe('/home/demo/a/b/c.txt')
  })

  it('posixResolve matches path.posix.resolve', () => {
    expect(posixResolve('/a/b', '../c/./d')).toBe('/a/c/d')
    expect(posixResolve('/a', '/x/../y')).toBe('/y')
    expect(posixResolve('/', '../..')).toBe('/')
  })
})

describe('markdown rendering', () => {
  it('marks path-like and command-like inline code as clickable, and only those', async () => {
    const { md } = await import('../app/utils/markdown')
    const html = md('See `~/project/src/app.ts:42` and `console.log`, then `npm test`.')
    expect(html).toContain('<code class="md-path" data-k="path" role="button" tabindex="0">~/project/src/app.ts:42</code>')
    expect(html).toContain('<code>console.log</code>')
    expect(html).toContain('<code class="md-cmd" data-k="cmd" data-cmd="npm test" role="button" tabindex="0">npm test</code>')
  })

  it('escapes inline code that is not a path', async () => {
    const { md } = await import('../app/utils/markdown')
    expect(md('Try `a<b>/c.ts`')).toContain('<code>a&lt;b&gt;/c.ts</code>')
  })

  it('leaves fenced code blocks alone', async () => {
    const { md } = await import('../app/utils/markdown')
    expect(md('```\n~/project/a.ts\n```')).not.toContain('md-path')
  })
})
