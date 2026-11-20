// "Open in editor": the server checks, then the real script run through /bin/sh
// with a fake `open` and `uname` that record what they were given (nothing is opened).
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(path.join(tmpdir(), 'open-editor-'))
const home = path.join(root, 'home')
const bin = path.join(root, 'bin')
const calls = path.join(root, 'calls.log')
const env = vi.hoisted(() => ({ os: 'Darwin', editor: '' }))

mkdirSync(path.join(home, 'project/src'), { recursive: true })
mkdirSync(path.join(root, 'outside'))
mkdirSync(bin)
writeFileSync(path.join(home, 'project/file.txt'), '')
symlinkSync(path.join(root, 'outside'), path.join(home, 'project/link'))
writeFileSync(path.join(bin, 'open'), `#!/bin/sh\nfor a; do printf '%s|' "$a"; done >> "${calls}"\necho >> "${calls}"\n`)
writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho "$FAKE_OS"\n')
chmodSync(path.join(bin, 'open'), 0o755)
chmodSync(path.join(bin, 'uname'), 0o755)
afterAll(() => rmSync(root, { recursive: true, force: true }))

vi.mock('../server/utils/env', async importOriginal => ({ ...await importOriginal<object>(), log: () => {} }))
vi.mock('../server/utils/state', () => ({ findPane: () => undefined }))
vi.mock('../server/utils/coreFilesMachine', () => ({ coreFilesMachine: () => undefined }))
vi.mock('../server/utils/herdr', () => ({
  HerdrError: class HerdrError extends Error {
    constructor(public code: string, message: string) { super(message) }
  },
}))

const { openEditor, OPEN_EDITOR_SCRIPT } = await import('../server/utils/openEditor')
const PANE = 'w1:p1'
let cwd: string | null = ''
const machine = { label: 'Test Mac', local: false }
const deps = {
  findPane: (id: string) => (id === PANE ? { cwd } : undefined),
  machine: async () => machine as never,
  run: async (_m: unknown, args: string[]) => {
    const r = spawnSync('/bin/sh', ['-c', OPEN_EDITOR_SCRIPT, 'sh', ...args], {
      env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_OS: env.os, ...(env.editor ? { WH_OPEN_EDITOR: env.editor } : {}) },
    })
    return { code: r.status, stdout: r.stdout, stderr: String(r.stderr || '') }
  },
}
const opened = () => { try { return readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) } catch { return [] } }
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)
const body = (pane_id = PANE) => openEditor({ pane_id }, deps)

beforeEach(() => {
  env.os = 'Darwin'
  env.editor = ''
  cwd = path.join(home, 'project')
  rmSync(calls, { force: true })
})

describe('open in editor', () => {
  it('opens the pane folder and answers with the machine', async () => {
    expect(await body()).toEqual({ ok: true, machine: 'Test Mac' })
    expect(opened()).toEqual([`${realpathSync(cwd!)}|`])
  })

  it('opens it in the configured editor, as one argument', async () => {
    env.editor = 'Zed'
    await body()
    expect(opened()).toEqual([`-a|Zed|${realpathSync(cwd!)}|`])
  })

  it('ignores an editor name that would be an option', async () => {
    env.editor = '-n'
    await body()
    expect(opened()).toEqual([`${realpathSync(cwd!)}|`])
  })

  it('needs a known pane with a folder', async () => {
    expect(await codeOf(body('x; rm'))).toBe('bad_pane')
    expect(await codeOf(body('w9:p9'))).toBe('bad_pane')
    cwd = null
    expect(await codeOf(body())).toBe('bad_path')
  })

  it('refuses a folder outside home, also through a symlink', async () => {
    cwd = path.join(root, 'outside')
    expect(await codeOf(body())).toBe('outside_home')
    cwd = path.join(home, 'project/link')
    expect(await codeOf(body())).toBe('outside_home')
    expect(opened()).toEqual([])
  })

  it('reports a missing folder or a file, and a machine that is not a Mac', async () => {
    cwd = path.join(home, 'project/nope')
    expect(await codeOf(body())).toBe('not_found')
    cwd = path.join(home, 'project/file.txt')
    expect(await codeOf(body())).toBe('not_found')
    cwd = path.join(home, 'project')
    env.os = 'Linux'
    const e = await body().catch(x => x)
    expect(e.code).toBe('not_mac')
    expect(e.message).toContain('Test Mac')
    expect(opened()).toEqual([])
  })

  it('passes a hostile folder name verbatim, never as shell text', async () => {
    const evil = path.join(home, `a'; touch pwned; echo '$(touch pwned2)\`id\``)
    mkdirSync(evil)
    cwd = evil
    await body()
    expect(opened()).toEqual([`${realpathSync(evil)}|`])
    for (const f of ['pwned', 'pwned2']) expect(() => readFileSync(path.join(home, f))).toThrow()
  })
})
