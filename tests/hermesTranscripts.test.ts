import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, expect, it } from 'vitest'
import { createShellFs } from '../server/utils/fsx'
import { createHermesTranscripts, locateHermes } from '../server/utils/hermesTranscripts'
// @ts-expect-error untyped test helper
import { writeHermesFixture } from './helpers/hermes-fixture.mjs'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })
function fixture(legacy = false) {
  const fx = writeHermesFixture({ legacy })
  dirs.push(fx.dir)
  return fx as { dir: string, file: string, id: string }
}
const texts = (r: { items?: { role: string, text?: string }[] }) => r.items?.map(i => `${i.role}:${i.text}`)
const WHOLE = [
  'user:List the files', 'tool:ls -la', 'assistant:Two files: a and b.', 'user:What is this?',
  'thinking:It looks like a diagram.', 'system:Conversation cleared', 'user:Fresh start', 'assistant:Hello again.',
]

it('reads a conversation without creating sidecars, then a live one while its gateway writes', async () => {
  const fx = fixture()
  const reader = createHermesTranscripts()
  const loc = { db: fx.file, session: fx.id }
  const r = await reader.chat(loc)
  expect(texts(r)).toEqual(WHOLE)
  // "\x00json:" multimodal content: read losslessly through node:sqlite.
  expect(r.items?.find(i => i.text === 'What is this?')).toMatchObject({ role: 'user', images: 1 })
  expect(fs.readdirSync(fx.dir)).toEqual(['state.db'])
  expect(await reader.chat(loc, { since: r.token })).toMatchObject({ unchanged: true })
  expect(await reader.model(loc)).toEqual({ id: 'test-model', label: expect.any(String) })

  // The gateway holds the database open: the unflushed WAL is read in place.
  const gateway = new DatabaseSync(fx.file)
  try {
    gateway.exec('PRAGMA wal_autocheckpoint=0')
    gateway.prepare("INSERT INTO messages (session_id, role, content, timestamp, message_uid) VALUES ('seg-3', 'user', 'Still there?', 1767268900, 'u11')").run()
    const names = fs.readdirSync(fx.dir).sort()
    const live = await reader.chat(loc, { since: r.token })
    expect(texts(live)?.at(-1)).toBe('user:Still there?')
    expect(fs.readdirSync(fx.dir).sort()).toEqual(names)
    expect((await reader.search(loc, 'still', Date.now() + 5000)).hits).toMatchObject([{ role: 'user', text: 'Still there?' }])
  } finally { gateway.close() }
})

it('pages older steps, reads an old schema, and fails closed', async () => {
  const fx = fixture()
  const reader = createHermesTranscripts()
  const loc = { db: fx.file, session: fx.id }
  const r = await reader.chat(loc)
  // The page above the last step (its row id).
  const before = Number(r.items!.at(-1)!.ref!.split(':')[0])
  const older = await reader.chat(loc, { before, anchor: r.token })
  expect(older).toMatchObject({ older: true })
  expect(texts(older)).toEqual(WHOLE.slice(0, -1))

  const legacy = fixture(true)
  // No message_uid, no receipt: compression links local-chat to seg-2 only.
  const old = await reader.chat({ db: legacy.file, session: legacy.id })
  expect(texts(old)?.filter(t => t.startsWith('assistant'))).toEqual(['assistant:Two files.', 'assistant:Two files: a and b.'])

  expect(await reader.chat({ db: fx.file, session: 'unknown' })).toEqual({ available: false, reason: 'not_found' })
  expect(await reader.chat({ db: `${fx.dir}/missing.db`, session: fx.id })).toEqual({ available: false, reason: 'not_found' })
  expect(await createHermesTranscripts({ sqlite: null }).chat(loc)).toEqual({ available: false, reason: 'unsupported' })
})

it.skipIf(spawnSync('python3', ['-c', 'import sqlite3']).status !== 0)('reads a remote database with the machine\'s Python', async () => {
  const fx = fixture()
  const exec = async (script: string, args: string[] = [], opts: { input?: Buffer } = {}) => await new Promise<{ code: number, stdout: Buffer, stderr: string }>((resolve) => {
    const child = execFile('sh', ['-c', script, 'sh', ...args], { encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout, stderr: stderr.toString() })
    })
    child.stdin!.end(opts.input ?? Buffer.alloc(0))
  })
  const remote = createHermesTranscripts({ fs: createShellFs(exec, { statTtlMs: 0 }) })
  const loc = { db: fx.file, session: fx.id, python: '/nonexistent/python' }
  expect(texts(await remote.chat(loc))).toEqual(WHOLE)
  expect(fs.readdirSync(fx.dir)).toEqual(['state.db'])
  expect(await remote.chat({ ...loc, db: `${fx.dir}/missing.db` })).toEqual({ available: false, reason: 'not_found' })
})

it('locates the session a Hermes pane shows: the TUI file, else the CLI bar', async () => {
  const b64 = (env: Record<string, string>) => Buffer.from(Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join('')).toString('base64')
  const id = '20260101_120000_abc123'
  const files: Record<string, string> = { '/tmp/hermes-tui-active-session-1.json': JSON.stringify({ session_id: id }), '/home/u/.hermes/active_profile': 'coder\n' }
  const machine = (probe: string) => ({
    readFile: async (f: string) => { if (f in files) return files[f]!; throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
    run: async () => Buffer.from(probe),
  }) as never
  const tui = `exe /opt/hermes/bin/python3\nenv ${b64({})}\n42 ${b64({ HERMES_TUI_ACTIVE_SESSION_FILE: '/tmp/hermes-tui-active-session-1.json', HERMES_HOME: '/home/u/.hermes/profiles/work' })}\n`
  expect(await locateHermes(machine(tui), '/home/u', { pid: 7 }, async () => ''))
    .toEqual({ db: '/home/u/.hermes/profiles/work/state.db', session: id, python: '/opt/hermes/bin/python3' })
  // Classic CLI: no Node child; the sticky profile and the bottom bar.
  const cli = `exe /usr/bin/python3\nenv ${b64({ HOME: '/home/u' })}\n`
  expect(await locateHermes(machine(cli), '/home/u', { pid: 7, argv: ['python3', '/opt/hermes/bin/hermes'] }, async () => `> \n ☤ test-model │ ${id} \n`))
    .toEqual({ db: '/home/u/.hermes/profiles/coder/state.db', session: id, python: '/usr/bin/python3' })
  // A bar cut off by a narrow pane: nothing.
  expect(await locateHermes(machine(cli), '/home/u', { pid: 7 }, async () => ' ☤ test-model │ 20260101_1200')).toBeNull()
})
