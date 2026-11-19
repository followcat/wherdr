// Multi-machine: prefixed IDs, routing of Herdr calls, `herdr machine
// list` profiles, and file access on a remote machine through shell commands
// (run locally here: same POSIX scripts as over SSH).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANE_RE, machineOf, splitId } from '../shared/ids'
import { type ShellExec, createShellFs, LIST_DIRS_SCRIPT, localFs, parseDirList, parseStatLine, shq } from '../server/utils/fsx'
import { createTranscripts, isMissing } from '../server/utils/transcripts'
import { FsError } from '../server/utils/fsx'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('IDs', () => {
  it('keeps local IDs as they are (links of notifications already sent)', () => {
    expect(splitId('w1:p1')).toEqual({ machine: '', local: 'w1:p1' })
    expect(PANE_RE.test('w1:p1')).toBe(true)
    expect(PANE_RE.test('wA:p12')).toBe(true)
  })

  it('prefixes the IDs of a remote machine', () => {
    const id = '12345678~w1:p1'
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

  it('reads a byte range, a file, a folder', async () => {
    const f = path.join(home, 'projets/fichier.txt')
    expect((await rfs.read(f, 3, 4)).toString()).toBe('3456')
    expect((await rfs.read(f, 8, 100)).toString()).toBe('89')
    expect(await rfs.readFile(f)).toBe('0123456789')
    expect((await rfs.readdir(path.join(home, 'projets'))).sort()).toEqual(['.cache', 'app', 'fichier.txt', "l'apostrophe et espaces", 'node_modules', 'notes'])
  })

  it('stat { fresh: true } bypasses the 700 ms stat cache', async () => {
    const f = path.join(home, 'projets/fresh.txt')
    writeFileSync(f, '0123456789')
    const cached = createShellFs(localSh, { statTtlMs: 60_000 })
    expect((await cached.stat(f)).size).toBe(10)
    writeFileSync(f, '0123456789abcdef')
    // A plain stat keeps answering the cached size within the TTL…
    expect((await cached.stat(f)).size).toBe(10)
    // …but a post-copy check must see the file as it is now.
    expect((await cached.stat(f, { fresh: true })).size).toBe(16)
    // The fresh answer replaces the cached one for the next plain stats.
    expect((await cached.stat(f)).size).toBe(16)
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

  it('lists the open files of a live process', async () => {
    // /proc fd targets like "socket:[1]" or "pipe:[2]" are not paths: filtered out.
    const files = await rfs.readProcessFiles!(process.pid)
    expect(files).not.toBeNull()
    expect(files!.length).toBeGreaterThan(0)
    expect(files!.every(f => f.startsWith('/'))).toBe(true)
  })

  it('readProcessFiles: an empty answer means "scanned, no matching files"', async () => {
    const fs = createShellFs(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }))
    expect(await fs.readProcessFiles!(1)).toEqual([])
  })

  it('readProcessFiles: a machine without /proc nor lsof answers null, never []', async () => {
    // A dead pid has no /proc/<pid>/fd, and this env hides lsof: nothing to scan
    // with → the "!" marker, reported as an unavailable scan.
    const noScanSh: ShellExec = (script, args = []) => new Promise((resolve) => {
      const child = spawn('env', ['-i', 'PATH=/nonexistent', '/bin/sh', '-c', script, 'sh', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      let err = ''
      child.stdout.on('data', (b: Buffer) => out.push(b))
      child.stderr.on('data', (b: Buffer) => { err += b.toString() })
      child.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: err }))
      child.stdin.end()
    })
    expect(await createShellFs(noScanSh).readProcessFiles!(4194303)).toBeNull()
    // Same contract when the marker comes from a distant shell verbatim.
    const fs = createShellFs(async () => ({ code: 0, stdout: Buffer.from('!\n'), stderr: '' }))
    expect(await fs.readProcessFiles!(1)).toBeNull()
  })

  it('readProcessFiles: an unreadable scan answers unknown, locally and remotely', async () => {
    // No /proc entry (a process that just exited): the local reader says
    // "unknown", never "no files".
    const gone = 4194303
    expect(await localFs.readProcessFiles!(gone)).toBeNull()
    // The remote script must answer the same when lsof cannot inspect the pid
    // (gone, another user, hidepid) instead of printing nothing.
    const bin = mkdtempSync(path.join(tmpdir(), 'hw-lsof-'))
    try {
      writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const lsofFailsSh: ShellExec = (script, args = []) => new Promise((resolve) => {
        const child = spawn('env', ['-i', `PATH=${bin}:/usr/bin:/bin`, '/bin/sh', '-c', script, 'sh', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
        const out: Buffer[] = []
        let err = ''
        child.stdout.on('data', (b: Buffer) => out.push(b))
        child.stderr.on('data', (b: Buffer) => { err += b.toString() })
        child.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: err }))
        child.stdin.end()
      })
      expect(await createShellFs(lsofFailsSh).readProcessFiles!(gone)).toBeNull()
    } finally { rmSync(bin, { recursive: true, force: true }) }
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

// herdr-core's machine.exec keeps only the first part of a command's output
// (8 MB), flagged `truncated`; with `maxBytes` the reader refuses a cut output
// (server/utils/coreTranscripts.ts). Here the cap is 4 KB.
describe('remote transcript larger than one exec output', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hw-capped-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))
  const CAP = 4096
  const cappedSh: ShellExec = async (script, args = [], opts = {}) => {
    const r = await localSh(script, args, opts)
    const truncated = r.stdout.length > CAP
    if (opts.maxBytes && truncated) return { code: 125, stdout: Buffer.alloc(0), stderr: 'output too large' }
    return { ...r, stdout: r.stdout.subarray(0, CAP) }
  }

  it('keeps the whole turn after a screenshot line bigger than the cap', async () => {
    // A turn as Claude Code writes it: a reply, a screenshot whose result is a
    // multi-KB line, then a narration (thinking block, shown "· summary" in the
    // terminal), more tool calls and the final answer.
    let n = 0
    const at = () => new Date(Date.UTC(2026, 0, 1, 13, 37, n++)).toISOString()
    const say = (part: object) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [part] }, timestamp: at() })
    const result = (id: string, content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, timestamp: at() })
    const shot = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(6000) } }]
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Make the background move' }, timestamp: at() }),
      say({ type: 'text', text: 'I check that the background really moves.' }),
      say({ type: 'tool_use', id: 't1', name: 'mcp__chrome__screenshot', input: {} }),
      result('t1', shot),
      say({ type: 'thinking', thinking: 'The background looks right. I add a reduced-motion test.', signature: 'sig' }),
      say({ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }),
      result('t2', 'ok'),
      say({ type: 'text', text: 'All pass. Committing and pushing.' }),
      say({ type: 'text', text: 'Done: the background moves.' }),
    ]
    const dir = path.join(home, '.claude/projects/-x')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'cap-1.jsonl'), lines.join('\n') + '\n')
    const t = createTranscripts({ home, herdr: async () => { throw new Error('no Herdr') }, fs: createShellFs(cappedSh, { statTtlMs: 0, readChunk: 1000 }) })
    const pane = { id: '12345678~w1:p1', agent: 'claude', cwd: '/x', agentSession: 'cap-1' }
    const want = ['Make the background move', 'I check that the background really moves.', 'mcp__chrome__screenshot',
      'The background looks right. I add a reduced-motion test.', 'npm test', 'All pass. Committing and pushing.', 'Done: the background moves.']
    // First load, then the next poll from its start: the same whole turn.
    const first = await t.chat(pane, {})
    expect(first.items!.map(i => i.role === 'tool' ? i.name === 'Bash' ? i.text : i.name : i.text)).toEqual(want)
    const next = await t.chat(pane, { from: first.start })
    expect(next.items!.map(i => i.role === 'tool' ? i.name === 'Bash' ? i.text : i.name : i.text)).toEqual(want)
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
