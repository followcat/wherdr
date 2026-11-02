// Multi-machine: prefixed IDs, routing of Herdr calls, `herdr machine
// list` profiles, and file access on a remote machine through shell commands
// (run locally here: same POSIX scripts as over SSH).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANE_RE, isSelfTarget, joinId, machineKey, machineOf, parseMachineList, parseStatusSocket, routeParams, splitId, targetHost } from '../shared/ids'
import { type ShellExec, MAX_ARG_BYTES, STAT_SCRIPT, createShellFs, LIST_DIRS_SCRIPT, parseDirList, parseStatLine, shq } from '../server/utils/fsx'
import { createTranscripts, isMissing } from '../server/utils/transcripts'
import { FsError } from '../server/utils/fsx'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('IDs', () => {
  it('keeps local IDs as they are (links of notifications already sent)', () => {
    expect(joinId('', 'w1:p1')).toBe('w1:p1')
    expect(splitId('w1:p1')).toEqual({ machine: '', local: 'w1:p1' })
    expect(PANE_RE.test('w1:p1')).toBe(true)
    expect(PANE_RE.test('wA:p12')).toBe(true)
  })

  it('prefixes the IDs of a remote machine', () => {
    const k = machineKey('12345678123456781234567812345678')
    expect(k).toBe('12345678')
    const id = joinId(k, 'w1:p1')
    expect(id).toBe('12345678~w1:p1')
    expect(PANE_RE.test(id)).toBe(true)
    expect(splitId(id)).toEqual({ machine: '12345678', local: 'w1:p1' })
    expect(machineOf(id)).toBe('12345678')
    expect(machineOf('w2:p3')).toBe('')
    // encodeURIComponent keeps "~": /#/a/12345678~w1:p1
    expect(encodeURIComponent(id)).toBe('12345678~w1%3Ap1')
  })

  it('refuses malformed IDs', () => {
    for (const bad of ['', 'p1', 'w1', 'zz~w1:p1', '12345678~', '~w1:p1', '12345678~w1:p1;rm', '../w1:p1']) {
      expect(PANE_RE.test(bad)).toBe(false)
    }
  })
})

describe('routage des appels Herdr', () => {
  it('routes to the pane\'s machine and makes the ID local', () => {
    expect(routeParams({ pane_id: '12345678~w1:p2', keys: ['enter'] }))
      .toEqual({ machine: '12345678', params: { pane_id: 'w1:p2', keys: ['enter'] } })
    expect(routeParams({ target: '12345678~w3:p1', text: 'salut' }))
      .toEqual({ machine: '12345678', params: { target: 'w3:p1', text: 'salut' } })
    expect(routeParams({ workspace_id: '12345678~w3' }).params).toEqual({ workspace_id: 'w3' })
  })

  it('stays local without a prefix, and without an ID', () => {
    expect(routeParams({ pane_id: 'w1:p1' })).toEqual({ machine: '', params: { pane_id: 'w1:p1' } })
    expect(routeParams({})).toEqual({ machine: null, params: {} })
  })

  it('refuses a call that mixes two machines', () => {
    expect(() => routeParams({ pane_id: 'aaaa1111~w1:p1', workspace_id: 'w1' })).toThrow()
  })
})

describe('herdr machine list --json', () => {
  const raw = JSON.stringify([
    { id: '12345678123456781234567812345678', label: 'Laptop', target: 'laptop', session: 'default', enabled: true, selected: false },
    { id: '0123456789abcdef0123456789abcdef', label: 'Éteinte', target: 'box', session: 'default', enabled: false },
    { id: 'abcdef0123456789abcdef0123456789', label: '', target: 'user@serveur', session: 'travail' },
    { id: 'deadbeefdeadbeefdeadbeefdeadbeef', label: 'Piège', target: '-oProxyCommand=evil', session: 'default', enabled: true },
    { id: 'ffffffff00000000ffffffff00000000', label: 'Session bizarre', target: 'h', session: '../x y', enabled: true },
  ])
  const list = parseMachineList(raw)

  it('keeps the enabled profiles, with a short key', () => {
    expect(list.map(m => m.key)).toEqual(['12345678', 'abcdef01', 'ffffffff'])
    expect(list[0]).toEqual({ key: '12345678', id: '12345678123456781234567812345678', label: 'Laptop', target: 'laptop', session: 'default' })
  })

  it('takes the target as the default label, refuses option targets and invalid sessions', () => {
    expect(list[1]!.label).toBe('user@serveur')
    expect(list[1]!.session).toBe('travail')
    expect(list.some(m => m.target.startsWith('-'))).toBe(false)
    expect(list[2]!.session).toBe('default')
  })

  it('survives unreadable output', () => {
    expect(parseMachineList('')).toEqual([])
    expect(parseMachineList('{"a":1}')).toEqual([])
  })

  it('ignores profiles pointing at this machine itself (the computer has the server among its machines)', () => {
    const raw2 = JSON.stringify([
      { id: '11111111aaaaaaaa11111111aaaaaaaa', label: 'Server', target: 'alice@host-a', session: 'default', enabled: true },
      { id: '22222222bbbbbbbb22222222bbbbbbbb', label: 'Server FQDN', target: 'host-a.example.ts.net', session: 'default', enabled: true },
      { id: '33333333cccccccc33333333cccccccc', label: 'Moi', target: 'localhost', session: 'default', enabled: true },
      { id: '44444444dddddddd44444444dddddddd', label: 'IP', target: 'alice@100.64.0.7:22', session: 'default', enabled: true },
      { id: '12345678123456781234567812345678', label: 'Laptop', target: 'laptop', session: 'default', enabled: true },
    ])
    expect(parseMachineList(raw2, ['host-a', '100.64.0.7']).map(m => m.label)).toEqual(['Laptop'])
    expect(isSelfTarget('127.0.0.1', [])).toBe(true)
    expect(isSelfTarget('laptop', ['host-a'])).toBe(false)
  })

  it('deduplicates profiles pointing at the same host and session', () => {
    const raw3 = JSON.stringify([
      { id: '12345678123456781234567812345678', label: 'Laptop', target: 'laptop', session: 'default', enabled: true },
      { id: 'aaaaaaaa00000000aaaaaaaa00000000', label: 'Laptop (FQDN)', target: 'alice@laptop.example.ts.net', session: 'default', enabled: true },
      { id: 'bbbbbbbb00000000bbbbbbbb00000000', label: 'Laptop work', target: 'laptop', session: 'travail', enabled: true },
    ])
    expect(parseMachineList(raw3).map(m => m.label)).toEqual(['Laptop', 'Laptop work'])
    expect(targetHost('alice@Laptop.example.ts.net.')).toBe('laptop')
    expect(targetHost('user@[fd7a::1]:2222')).toBe('fd7a::1')
    expect(targetHost('host:2222')).toBe('host')
    expect(targetHost('10.0.0.5')).toBe('10.0.0.5')
  })

  it('reads the socket in `herdr status server`', () => {
    const out = 'status: running\nversion: 0.9.1\nendpoint_compatible: yes\nsocket: /Users/alice/.config/herdr/herdr.sock\n'
    expect(parseStatusSocket(out)).toBe('/Users/alice/.config/herdr/herdr.sock')
    expect(parseStatusSocket('status: stopped\n')).toBeNull()
  })
})

// Simulated "remote machine": the scripts go through `sh -c`, as over SSH.
const localSh: ShellExec = (script, args = [], opts = {}) => new Promise((resolve) => {
  const child = spawn('sh', ['-c', script, 'sh', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  const out: Buffer[] = []
  let err = ''
  child.stdout.on('data', (b: Buffer) => out.push(b))
  child.stderr.on('data', (b: Buffer) => { err += b.toString() })
  child.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: err }))
  child.stdin.end(opts.input || undefined)
})

describe('files of a remote machine (shell)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hw-remote-'))
  mkdirSync(path.join(home, 'projets/app/.git'), { recursive: true })
  mkdirSync(path.join(home, 'projets/notes'), { recursive: true })
  mkdirSync(path.join(home, 'projets/node_modules'), { recursive: true })
  mkdirSync(path.join(home, 'projets/.cache'), { recursive: true })
  mkdirSync(path.join(home, "projets/l'apostrophe et espaces"), { recursive: true })
  writeFileSync(path.join(home, 'projets/fichier.txt'), '0123456789')
  const rfs = createShellFs(localSh, { statTtlMs: 0 })

  it('stat (BSD ou GNU) : taille, type, absent', async () => {
    const [f, d, none] = await rfs.statMany([path.join(home, 'projets/fichier.txt'), path.join(home, 'projets'), path.join(home, 'nope')])
    expect(f).toMatchObject({ size: 10, isFile: true, isDir: false })
    expect(d).toMatchObject({ isFile: false, isDir: true })
    expect(none).toBeNull()
    await expect(rfs.stat(path.join(home, 'nope'))).rejects.toThrow()
    expect(parseStatLine('1234 1758860000 Regular File')).toEqual({ size: 1234, mtimeMs: 1758860000000, isFile: true, isDir: false })
    expect(parseStatLine('0 1758860000 regular empty file')!.isFile).toBe(true)
    expect(parseStatLine('x')).toBeNull()
    expect(parseStatLine('1234 1758860000 98765 regular file')).toEqual({ size: 1234, mtimeMs: 1758860000000, isFile: true, isDir: false, ino: 98765 })
    expect(parseStatLine('0 1758860000 12 directory')!.isDir).toBe(true)
    expect(parseStatLine('5 1758860000.800000000 12 regular file')!.mtimeMs).toBe(1758860000800)
    expect(parseStatLine('5 1758860000.123456789 12 regular file')!.mtimeMs).toBeCloseTo(1758860000123.456, 3)
  })

  it('bounds stat batches by argument bytes', async () => {
    const calls: string[][] = []
    const exec = async (script: string, args: string[] = []) => {
      expect(script).toBe(STAT_SCRIPT)
      calls.push(args)
      return { code: 0, stdout: Buffer.from(args.map(() => '10 1758860000 1 regular file').join('\n')), stderr: '' }
    }
    const fs = createShellFs(exec, { statTtlMs: 0 })
    const paths = Array.from({ length: 1500 }, (_, i) => `/home/user/.commandcode/projects/project-${i}/${'s'.repeat(80)}${i}.jsonl`)
    const stats = await fs.statMany(paths)
    expect(stats).toHaveLength(1500)
    expect(stats.every(s => s?.size === 10)).toBe(true)
    expect(calls.length).toBeGreaterThan(1)
    for (const args of calls) expect(args.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0)).toBeLessThanOrEqual(MAX_ARG_BYTES)
  })

  it('reads a byte range, a file, a folder', async () => {
    const f = path.join(home, 'projets/fichier.txt')
    expect((await rfs.read(f, 3, 4)).toString()).toBe('3456')
    expect((await rfs.read(f, 8, 100)).toString()).toBe('89')
    expect(await rfs.readFile(f)).toBe('0123456789')
    expect((await rfs.readdir(path.join(home, 'projets'))).sort()).toEqual(['.cache', 'app', 'fichier.txt', "l'apostrophe et espaces", 'node_modules', 'notes'])
  })

  it('lists subfolders (Git repositories marked, hidden ones and node_modules excluded)', async () => {
    const r = await localSh(LIST_DIRS_SCRIPT, [path.join(home, 'projets')])
    const dirs = parseDirList(r.stdout.toString())
    expect(dirs.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'app', git: true },
      { name: "l'apostrophe et espaces", git: false },
      { name: 'notes', git: false },
    ])
  })

  it('quotes arguments without ever interpreting them', async () => {
    const evil = `a'; echo pwned; '$(id)`
    const r = await localSh(`printf %s "$1"`, [evil])
    expect(r.stdout.toString()).toBe(evil)
    expect(shq("it's")).toBe(`'it'\\''s'`)
  })

  it('re-reads a remote transcript like a local one', async () => {
    const claudeDir = path.join(home, '.claude/projects/-Users-x')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(path.join(claudeDir, 'abc-123.jsonl'), fx('claude-session.jsonl'))
    const t = createTranscripts({ home, herdr: async () => { throw new Error('pas de Herdr') }, fs: rfs })
    const pane = { id: '12345678~w1:p1', agent: 'claude', cwd: '/Users/x', agentSession: 'abc-123' }
    const r = await t.chat(pane, {})
    expect(r.available).toBe(true)
    expect(r.items!.length).toBeGreaterThan(10)
    expect(await t.preview(pane)).toBe('fini encore')
    const withImg = r.items!.find(i => i.images)!
    const img = await t.image(pane, r.file!, withImg.ref!, 0)
    expect(img!.type).toBe('image/jpeg')
    const size = Buffer.byteLength(fx('claude-session.jsonl'))
    const older = await t.chat(pane, { before: Math.floor(size / 2) })
    expect(older.older).toBe(true)
  })
})

describe('remote missing paths without shell diagnostic matching', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hw-missing-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))
  const operations = ['readdir', 'readFile', 'read'] as const
  const read = (fs: ReturnType<typeof createShellFs>, op: typeof operations[number], p: string) =>
    op === 'read' ? fs.read(p, 0, 100) : fs[op](p)

  it.each(operations)('%s reports ENOENT for an absent path through POSIX sh', async (op) => {
    await expect(read(createShellFs(localSh), op, path.join(home, 'absent')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(operations)('%s recognizes the dedicated status even with dash wording', async (op) => {
    const fs = createShellFs(async () => ({
      code: 44, stdout: Buffer.alloc(0), stderr: "sh: 1: cd: can't cd to /missing/day",
    }))
    await expect(read(fs, op, '/missing/day')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    [2, "sh: 1: cd: can't cd to /restricted/day", 'remote'],
    [1, 'Permission denied', 'remote'],
    [255, 'Connection closed', 'unreachable'],
    [124, 'Timed out', 'unreachable'],
    [null, '', 'remote'],
  ] as const)('does not classify status %s as an absent path', async (code, stderr, expected) => {
    const fs = createShellFs(async () => ({ code, stdout: Buffer.alloc(0), stderr }))
    for (const op of operations) {
      await expect(read(fs, op, '/restricted/day')).rejects.toMatchObject({ code: expected })
    }
  })

  it('finds a Codex conversation when the other recent day folders are absent', async () => {
    const now = new Date()
    // Today is absent; the conversation is in yesterday's folder. The third
    // day is absent too, so lookup must continue on both sides of a match.
    const yesterday = new Date(now.getTime() - 86400000)
    const dir = path.join(home, '.codex/sessions', String(yesterday.getFullYear()),
      String(yesterday.getMonth() + 1).padStart(2, '0'), String(yesterday.getDate()).padStart(2, '0'))
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'rollout-example-session.jsonl')
    writeFileSync(file, [
      { type: 'session_meta', payload: { id: 'example-session', cwd: '/workspace/app', timestamp: yesterday.toISOString(), thread_source: 'user' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Conversation found' }] } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    const transcripts = createTranscripts({ home, fs: createShellFs(localSh), herdr: async () => ({}) })
    const result = await transcripts.chat({ id: '12345678~w1:p1', agent: 'codex', cwd: '/workspace/app' }, {})
    expect(result.available).toBe(true)
    expect(result.file).toBe(path.basename(file))
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Conversation found' })]))
  })
})

// Remote read that falters (SSH cut, timeout): the conversation
// already found must never become "not found" (the view would empty).
describe('transcription distante instable', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hw-flaky-'))
  const dir = path.join(home, '.claude/projects/-Users-x')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'abc-123.jsonl')
  writeFileSync(file, fx('claude-session.jsonl'))
  let mode: 'ok' | 'fail' | 'timeout' = 'ok'
  const flakySh: ShellExec = (script, args, opts) => {
    if (mode === 'fail') return Promise.resolve({ code: 255, stdout: Buffer.alloc(0), stderr: 'Connection closed by remote host' })
    if (mode === 'timeout') return Promise.resolve({ code: null, stdout: Buffer.alloc(0), stderr: '' }) // killed at the timeout
    return localSh(script, args, opts)
  }
  const fs = createShellFs(flakySh, { statTtlMs: 0 })
  const noHerdr = async () => { throw new Error('pas de Herdr') }
  const pane = { id: '12345678~w1:p1', agent: 'claude', cwd: '/Users/x', agentSession: 'abc-123' }

  it('tells a missing file from a failed read', () => {
    expect(isMissing(new FsError('ENOENT', 'introuvable : x'))).toBe(true)
    expect(isMissing(new FsError('remote', 'cat: x: No such file or directory'))).toBe(true)
    expect(isMissing(new FsError('remote', 'Connection closed by remote host'))).toBe(false)
    expect(isMissing(new FsError('remote', 'code null'))).toBe(false)
  })

  it('read failing or timed out: an error, never "not found"', async () => {
    const t = createTranscripts({ home, herdr: noHerdr, fs })
    mode = 'ok'
    expect((await t.chat(pane, {})).available).toBe(true)
    t.forget(pane.id) // forced relocation: that is what failed with "not_found"
    const again = createTranscripts({ home, herdr: noHerdr, fs })
    expect((await again.chat(pane, {})).available).toBe(true)
    for (const m of ['fail', 'timeout'] as const) {
      mode = m
      await expect(again.chat(pane, {})).rejects.toThrow()
    }
    mode = 'ok'
    expect((await again.chat(pane, {})).available).toBe(true)
  })

  it('file lookup failed: we keep the last known file', async () => {
    const t = createTranscripts({ home, herdr: noHerdr, fs })
    mode = 'ok'
    const first = await t.chat(pane, {})
    // Session missing from a poll (incomplete snapshot) and SSH faltering.
    mode = 'fail'
    const loc = await t.locate({ ...pane, agentSession: null })
    expect(loc && loc.file).toBe(file)
    mode = 'ok'
    const r = await t.chat({ ...pane, agentSession: null }, {})
    expect(r.available).toBe(true)
    expect(r.file).toBe(first.file)
  })

  it('file really deleted: "not found"', async () => {
    const other = path.join(dir, 'gone-1.jsonl')
    writeFileSync(other, fx('claude-session.jsonl'))
    const t = createTranscripts({ home, herdr: noHerdr, fs })
    mode = 'ok'
    const p = { ...pane, id: '12345678~w1:p2', agentSession: 'gone-1' }
    expect((await t.chat(p, {})).available).toBe(true)
    const { rmSync } = await import('node:fs')
    rmSync(other)
    t.forget(p.id)
    expect(await t.chat(p, {})).toEqual({ available: false, reason: 'not_found' })
  })
})
