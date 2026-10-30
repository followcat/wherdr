// Transcripts: Claude (real lines from a test session + a few synthetic
// lines) and Codex (reduced test rollout + synthetic tool calls).
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTranscripts, extractImage, parseLines, stripBlobs } from '../server/utils/transcripts'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const HOME = '/home/user'

describe('Claude', () => {
  const items = parseLines(fx('claude-session.jsonl'), 'claude', 0, HOME)
  const texts = items.map(i => `${i.role}:${i.text}`)

  it('keeps user messages and replies', () => {
    expect(texts).toContain('user:Réponds seulement par le mot : pong')
    expect(texts).toContain('assistant:pong')
    expect(texts).toContain('assistant:ok')
  })

  it('summarizes tools (paths shortened with ~) and marks errors', () => {
    const write = items.find(i => i.role === 'tool' && i.name === 'Write')!
    expect(write.text).toBe('~/dev/sandbox/hello.txt')
    const sleep = items.find(i => i.role === 'tool' && i.name === 'Bash' && i.text === 'Wait 25 seconds')!
    expect(sleep.error).toBe(true)
    const ask = items.find(i => i.role === 'tool' && i.name === 'AskUserQuestion')!
    expect(ask.text).toMatch(/couleur/)
  })

  it('montre un message pris en cours de tour (attachment queued_command)', () => {
    expect(texts).toContain('user:Ensuite, réponds aussi : encore')
  })

  it('follows Claude\'s queue (enqueue, remove, dequeue)', () => {
    expect(items.queue).toEqual([{ text: 'Encore une chose', ts: '2026-09-25T11:40:05.000Z', images: 1 }])
  })

  it('counts images and keeps the line position', () => {
    const img = items.find(i => i.role === 'user' && i.images)!
    expect(img.images).toBe(1)
    expect(img.text).toBe('Regarde cette image et décris-la en 3 mots maximum.')
    expect(img.ref).toMatch(/^\d+:\d+$/)
  })

  it('translates compaction, interruption and commands; ignores noise and subagents', () => {
    expect(texts).toContain('system:Conversation compacted')
    expect(texts).toContain('system:Interrupted')
    expect(texts).toContain('cmd:/compact garde le plan')
    expect(texts.some(t => t.startsWith('cmd:/context'))).toBe(true)
    expect(texts.some(t => t.includes('bruit'))).toBe(false)
    expect(texts.some(t => t.includes('sous-agent'))).toBe(false)
    expect(texts.some(t => t.includes('Context Usage'))).toBe(false) // isMeta
    expect(texts.some(t => t.includes('task-notification'))).toBe(false)
  })

  it('empties base64 images of very long lines before JSON.parse', () => {
    const big = JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { data: 'A'.repeat(60000) } }] } })
    const s = stripBlobs(big)
    expect(s.length).toBeLessThan(200)
    expect(JSON.parse(s).message.content[0].source.data).toBe('')
  })
})

describe('Codex', () => {
  const items = parseLines(fx('codex-rollout.jsonl'), 'codex')
  it('keeps the real messages (not the environment context)', () => {
    const msgs = items.filter(i => i.role !== 'tool').map(i => `${i.role}:${i.text}`)
    expect(msgs[0]).toBe('user:Réponds juste : pong')
    expect(msgs[1]).toBe('assistant:pong')
    expect(msgs.some(m => m.includes('environment_context'))).toBe(false)
  })
  it('summarizes tool calls', () => {
    const tools = items.filter(i => i.role === 'tool').map(i => `${i.name}:${i.text}`)
    expect(tools).toEqual(['shell:bash -lc ls -la', 'exec:git status --short', 'exec:write_stdin', 'shell:npm test'])
  })
  it('compte les images', () => {
    const img = items.find(i => i.images)!
    expect(img.text).toBe('Regarde ça')
    expect(img.images).toBe(1)
  })
})

describe('extractImage', () => {
  const b64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')
  it('never serves an SVG image (or an unknown type) as such', () => {
    const codex = { payload: { content: [{ type: 'input_image', image_url: `data:image/svg+xml;base64,${b64}` }] } }
    expect(extractImage(codex, 0)!.type).toBe('application/octet-stream')
    const claude = { message: { content: [{ type: 'image', source: { media_type: 'text/html', data: b64 } }] } }
    expect(extractImage(claude, 0)!.type).toBe('application/octet-stream')
  })
  it('keeps common image types', () => {
    const d = { message: { content: [{ type: 'image', source: { media_type: 'image/PNG', data: b64 } }] } }
    expect(extractImage(d, 0)!.type).toBe('image/png')
    expect(extractImage(d, 1)).toBeNull()
  })
  it('finds the images of Claude and Codex tool results', () => {
    const b64 = Buffer.from('x').toString('base64')
    const j = (o: object) => JSON.stringify(o)
    const claude = [
      j({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/x/a.png' } }] } }),
      j({ type: 'user', timestamp: 't', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }] }] } }),
    ].join('\n')
    const ct = parseLines(claude, 'claude', 0, HOME).find(i => i.role === 'tool')!
    expect(ct.images).toBe(1)
    expect(extractImage(JSON.parse(claude.split('\n')[1]!), ct.imageAt || 0)!.type).toBe('image/jpeg')
    const codex = [
      j({ type: 'response_item', timestamp: 't', payload: { type: 'function_call', name: 'view_image', call_id: 'c1', arguments: '{"path":"/x/a.png"}' } }),
      j({ type: 'response_item', timestamp: 't', payload: { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: `data:image/webp;base64,${b64}` }] } }),
    ].join('\n')
    const xt = parseLines(codex, 'codex').find(i => i.role === 'tool')!
    expect(xt.images).toBe(1)
    expect(extractImage(JSON.parse(codex.split('\n')[1]!), 0)!.type).toBe('image/webp')
  })
})

describe('createTranscripts', () => {
  // A temporary $HOME with a Claude transcript and a Codex rollout.
  const home = mkdtempSync(path.join(tmpdir(), 'hw-home-'))
  const claudeDir = path.join(home, '.claude/projects/-home-x')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(path.join(claudeDir, 'abc-123.jsonl'), fx('claude-session.jsonl'))
  const codexDir = path.join(home, '.codex/sessions/2026/09/25')
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(path.join(codexDir, 'rollout-2026-09-25T21-29-56-00000000-0000-4000-8000-00000000c0de.jsonl'), fx('codex-rollout.jsonl'))
  const herdr = async () => { throw new Error('pas de Herdr dans les tests') }
  const t = createTranscripts({ home, herdr })
  const claude = { id: 'w1:p1', agent: 'claude', cwd: '/home/x', agentSession: 'abc-123' }

  it('finds the transcript by session id and replies "unchanged"', async () => {
    const r = await t.chat(claude, {})
    expect(r.available).toBe(true)
    expect(r.file).toBe('abc-123.jsonl')
    expect(r.items!.length).toBeGreaterThan(10)
    const again = await t.chat(claude, { since: r.token })
    expect(again.unchanged).toBe(true)
  })

  it('re-reads an older slice (before) and the bottom from a byte (from)', async () => {
    const size = Buffer.byteLength(fx('claude-session.jsonl'))
    const older = await t.chat(claude, { before: Math.floor(size / 2) })
    expect(older.older).toBe(true)
    const tail = await t.chat(claude, { from: Math.floor(size / 2) })
    expect(tail.start).toBe(Math.floor(size / 2))
    expect(tail.items!.length).toBeLessThan((await t.chat(claude, {})).items!.length)
  })

  it('fresh: looks again for a transcript a brand new Claude just wrote', async () => {
    // Herdr answering, with no process yet: the "no file" result is cached.
    const t = createTranscripts({ home, herdr: async () => ({ process_info: { foreground_processes: [] } }) })
    const pane = { id: 'w9:p1', agent: 'claude', cwd: '/home/x', agentSession: 'new-456' }
    expect(await t.chat(pane, {})).toEqual({ available: false, reason: 'not_found' })
    writeFileSync(path.join(claudeDir, 'new-456.jsonl'), fx('claude-session.jsonl'))
    // "No file" stays cached for a few seconds…
    expect((await t.chat(pane, {})).available).toBe(false)
    // …except for a fresh read (Stop or Cancel of the first message).
    expect((await t.chat(pane, { fresh: true })).available).toBe(true)
    expect((await t.chat(pane, {})).available).toBe(true)
  })

  it('gives the preview of the last reply', async () => {
    expect(await t.preview(claude)).toBe('fini encore') // markdown and line breaks flattened
  })

  it('keeps a stable notification identity across reads and changes it for a new reply', async () => {
    const file = path.join(claudeDir, 'notice-example.jsonl')
    const pane = { ...claude, id: 'w8:p1', agentSession: 'notice-example' }
    const line = (text: string, timestamp: string) => JSON.stringify({ type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
    writeFileSync(file, line('First answer', '2026-01-01T00:00:00Z'))
    const first = await t.latestReply(pane)
    expect(first?.text).toBe('First answer')
    expect(await t.latestReply(pane)).toEqual(first)
    writeFileSync(file, line('First answer, with more streamed text', '2026-01-01T00:00:00Z'))
    expect((await t.latestReply(pane))?.key).toBe(first?.key)
    writeFileSync(file, line('First answer', '2026-01-01T00:00:00Z') + line('Next answer', '2026-01-01T00:01:00Z'))
    const next = await t.latestReply(pane)
    expect(next?.text).toBe('Next answer')
    expect(next?.key).not.toBe(first?.key)
  })

  it('re-reads an image by its position', async () => {
    const r = await t.chat(claude, {})
    const it2 = r.items!.find(i => i.images)!
    const img = await t.image(claude, r.file!, it2.ref!, 0)
    // Photo shrunk to JPEG by the browser before sending.
    expect(img!.type).toBe('image/jpeg')
    expect([...img!.body.subarray(0, 2)]).toEqual([0xFF, 0xD8])
    expect(await t.image(claude, 'autre.jsonl', it2.ref!, 0)).toBeNull()
  })

  it('finds a Codex rollout by its id', async () => {
    const codex = { id: 'w2:p1', agent: 'codex', cwd: '/x', agentSession: '00000000-0000-4000-8000-00000000c0de' }
    const r = await t.chat(codex, {})
    expect(r.available).toBe(true)
    expect(r.items![0]!.text).toBe('Réponds juste : pong')
    const it2 = r.items!.find(i => i.images)!
    const img = await t.image(codex, r.file!, it2.ref!, 0)
    expect(img!.type).toBe('image/png')
  })

  it('answers "no conversation" when the session path is a directory', async () => {
    // A folder named like a rollout (or a Claude transcript): no EISDIR.
    const id = '00000000-0000-4000-8000-0000000d1e00'
    mkdirSync(path.join(codexDir, `rollout-2026-09-25T21-30-00-${id}.jsonl`))
    mkdirSync(path.join(claudeDir, 'dir-789.jsonl'))
    const codex = { id: 'w4:p1', agent: 'codex', cwd: '/x', agentSession: id }
    expect(await t.chat(codex, {})).toEqual({ available: false, reason: 'not_found' })
    const claudeDirPane = { id: 'w5:p1', agent: 'claude', cwd: '/home/x', agentSession: 'dir-789' }
    const t2 = createTranscripts({ home, herdr: async () => ({ process_info: { foreground_processes: [] } }) })
    expect(await t2.chat(claudeDirPane, {})).toEqual({ available: false, reason: 'not_found' })
  })

  it('refuses an unsupported agent', async () => {
    expect(await t.chat({ id: 'w3:p1', agent: null, cwd: null }, {})).toEqual({ available: false, reason: 'unsupported' })
  })
})

describe('omp', () => {
  const j = (o: object) => JSON.stringify(o)
  const msg = (message: object, ts: string, extra = {}) => j({ type: 'message', id: ts, timestamp: ts, message, ...extra })
  const hash = 'ab'.repeat(32)
  const lines = [
    j({ type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00Z', cwd: '/home/user/x' }),
    j({ type: 'model_change', timestamp: '2026-01-01T00:00:00Z', model: 'anthropic/claude-opus-5-5' }),
    msg({ role: 'user', content: [{ type: 'text', text: 'rappel injecté' }], synthetic: true, attribution: 'agent' }, '2026-01-01T00:00:01Z'),
    msg({ role: 'developer', content: [{ type: 'text', text: '<system-reminder>todo</system-reminder>' }] }, '2026-01-01T00:00:01Z'),
    msg({ role: 'user', content: [{ type: 'text', text: 'Regarde ça [Image #1, 756x477]' }, { type: 'image', data: `blob:sha256:${hash}`, mimeType: 'image/webp' }], attribution: 'user' }, '2026-01-01T00:00:02Z'),
    msg({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'réflexion privée' },
      { type: 'text', text: 'Je lis.' },
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/home/user/x/a.ts', i: 'Reading a.ts' } },
      { type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'false\necho' } },
    ] }, '2026-01-01T00:00:03Z'),
    msg({ role: 'toolResult', toolCallId: 't2', toolName: 'bash', content: [{ type: 'text', text: 'exit 1' }], isError: true }, '2026-01-01T00:00:04Z'),
    j({ type: 'custom_message', customType: 'skill-prompt', attribution: 'user', timestamp: '2026-01-01T00:00:05Z', content: '# Skill…', details: { name: 'plan', args: 'la suite' } }),
    j({ type: 'custom_message', customType: 'mid-run-todo-nudge', display: false, attribution: 'agent', timestamp: '2026-01-01T00:00:05Z', content: 'note interne' }),
    j({ type: 'custom_message', customType: 'advisor', display: true, attribution: 'agent', timestamp: '2026-01-01T00:00:05Z', content: '<advisory>\n`a &lt; b`\n</advisory>', details: { notes: [{ note: 'Vérifie `a < b`.', severity: 'concern' }, { note: 'Sinon ok.' }] } }),
    j({ type: 'custom_message', customType: 'irc:incoming', display: true, attribution: 'agent', timestamp: '2026-01-01T00:00:05Z', content: '<irc>\nIncoming IRC message from agent `Main`:\n\nSalut\n</irc>' }),
    msg({ role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Interrupted by user' }, '2026-01-01T00:00:06Z'),
    j({ type: 'compaction', timestamp: '2026-01-01T00:00:07Z', summary: 'résumé' }),
    msg({ role: 'user', content: 'Continue', attribution: 'user', steering: true }, '2026-01-01T00:00:08Z'),
    msg({ role: 'assistant', content: [{ type: 'text', text: '**Fini**' }] }, '2026-01-01T00:00:09Z'),
  ].join('\n') + '\n'

  it('keeps user messages, replies and tools; ignores agent injections', () => {
    const items = parseLines(lines, 'omp', 0, HOME)
    expect(items.map(i => `${i.role}:${i.name ? i.name + ' ' : ''}${i.text}${i.error ? ' !' : ''}`)).toEqual([
      'user:Regarde ça',
      'thinking:réflexion privée',
      'assistant:Je lis.',
      'tool:Read Reading a.ts',
      'tool:Bash false !',
      'user:/skill:plan la suite',
      'notice:advisor **concern** — Vérifie `a < b`.\n\nSinon ok.',
      'notice:irc:incoming Incoming IRC message from agent `Main`:\n\nSalut',
      'system:Interrupted',
      'system:Conversation compacted',
      'user:Continue',
      'assistant:**Fini**',
    ])
    expect(items[0]!.images).toBe(1)
    expect(items[0]!.ref).toMatch(/^\d+:\d+$/)
  })

  it('puts "/name args" back instead of a file command\'s text', () => {
    const body = '# Aside\n\nRéponds vite, puis reprends la tâche.'
    const long = `Revue complète du code. ${'Vérifie chaque fichier modifié. '.repeat(8)}`
    const said = (text: string) => msg({ role: 'user', content: [{ type: 'text', text }], attribution: 'user' }, '2026-01-01T00:00:10Z')
    const items = parseLines([said(`${body}\n\nquelle heure ?`), said(body), said(`${long}\n\nfichier : a.ts`), said('# Aside mais autre chose')].join('\n'), 'omp', 0, HOME,
      [{ name: 'aside', body }, { name: 'review', body: `${long}\n\nPlus de consignes : $ARGUMENTS` }])
    expect(items.map(i => i.text)).toEqual(['/aside quelle heure ?', '/aside', '/review', '# Aside mais autre chose'])
  })

  it('attaches the images a tool returned to its action', () => {
    const png = 'cd'.repeat(32)
    const text = [
      msg({ role: 'assistant', content: [
        { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: '/x/shot.png' } },
        { type: 'toolCall', id: 'r2', name: 'bash', arguments: { command: 'ls' } },
      ] }, '2026-01-01T00:00:01Z'),
      msg({ role: 'toolResult', toolCallId: 'r2', content: [{ type: 'text', text: 'a' }] }, '2026-01-01T00:00:02Z'),
      msg({ role: 'toolResult', toolCallId: 'r1', content: [{ type: 'text', text: '' }, { type: 'image', mimeType: 'image/png', data: `blob:sha256:${png}` }] }, '2026-01-01T00:00:03Z'),
    ].join('\n')
    const items = parseLines(text, 'omp', 0, HOME)
    const read = items.find(i => i.name === 'Read')!
    expect(items.find(i => i.name === 'Bash')!.images).toBeUndefined()
    expect(read.images).toBe(1)
    const [start, len] = read.ref!.split(':').map(Number)
    const line = Buffer.from(text).subarray(start, start! + len!).toString()
    expect(extractImage(JSON.parse(line), 0)).toEqual({ type: 'image/png', blob: png })
  })

  it('reads the session reported by the integration (path) and re-reads its images in ~/.omp/agent/blobs', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-omp-'))
    const dir = path.join(home, '.omp/agent/sessions/-x')
    mkdirSync(dir, { recursive: true })
    mkdirSync(path.join(home, '.omp/agent/blobs'), { recursive: true })
    const file = path.join(dir, '2026-01-01T00-00-00-000Z_s1.jsonl')
    writeFileSync(file, lines)
    writeFileSync(path.join(home, '.omp/agent/blobs', hash), Buffer.from('RIFF0000WEBP'))
    const t = createTranscripts({ home, herdr: async () => { throw new Error('pas de Herdr') } })
    const omp = { id: 'wO:p1', agent: 'omp', cwd: '/x', agentSession: file }
    const r = await t.chat(omp, {})
    expect(r.available).toBe(true)
    expect(r.file).toBe(path.basename(file))
    expect(await t.preview(omp)).toBe('Fini')
    const img = await t.image(omp, r.file!, r.items!.find(i => i.images)!.ref!, 0)
    expect(img!.type).toBe('image/webp')
    expect(img!.body.toString()).toBe('RIFF0000WEBP')
    expect((await t.search(omp, 'regarde', Date.now() + 5000)).hits.map(h => h.text)).toEqual(['Regarde ça'])
    expect(await t.chat({ ...omp, id: 'wO:p2', agentSession: path.join(dir, 'absent.jsonl') }, {})).toEqual({ available: false, reason: 'not_found' })
    // Another readable .jsonl, outside omp's sessions: never served.
    const other = path.join(home, 'autre.jsonl')
    writeFileSync(other, lines)
    expect(await t.chat({ ...omp, id: 'wO:p3', agentSession: other }, {})).toEqual({ available: false, reason: 'not_found' })
    expect(await t.chat({ ...omp, id: 'wO:p4', agentSession: `${dir}/../../../../autre.jsonl` }, {})).toEqual({ available: false, reason: 'not_found' })
    // File command from ~/.omp/agent/commands: the conversation shows "/name args".
    mkdirSync(path.join(home, '.omp/agent/commands'), { recursive: true })
    writeFileSync(path.join(home, '.omp/agent/commands/aside.md'), '---\ndescription: Aparté\n---\n# Aside\n\nRéponds vite.\n')
    const withCmd = path.join(dir, '2026-01-02T00-00-00-000Z_s2.jsonl')
    writeFileSync(withCmd, msg({ role: 'user', content: [{ type: 'text', text: '# Aside\n\nRéponds vite.\n\nquelle heure ?' }], attribution: 'user' }, '2026-01-02T00:00:00Z') + '\n')
    const t2 = createTranscripts({ home, herdr: async () => { throw new Error('pas de Herdr') } })
    expect((await t2.chat({ ...omp, id: 'wO:p5', agentSession: withCmd }, {})).items!.map(i => i.text)).toEqual(['/aside quelle heure ?'])
  })

  it('keeps reading an omp session as omp while the pane reports another agent', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-omp-kind-'))
    const dir = path.join(home, '.omp/agent/sessions/-x')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '2026-01-01T00-00-00-000Z_s1.jsonl')
    const say = (text: string) => msg({ role: 'user', content: [{ type: 'text', text }], attribution: 'user' }, '2026-01-01T00:00:00Z') + '\n'
    writeFileSync(file, say('first'))
    const t = createTranscripts({ home, herdr: async () => { throw new Error('pas de Herdr') } })
    const omp = { id: 'wK:p1', agent: 'omp', cwd: '/x', agentSession: file }
    expect((await t.chat(omp, {})).items!.map(i => i.text)).toEqual(['first'])
    // The file grows, then the pane is first read while it reports Codex with the same session.
    writeFileSync(file, say('first') + say('second'))
    expect((await t.chat({ ...omp, agent: 'codex' }, {})).items!.map(i => i.text)).toEqual(['first', 'second'])
    expect((await t.chat({ ...omp, agent: 'codex' }, { from: 0 })).items!.map(i => i.text)).toEqual(['first', 'second'])
    expect((await t.chat(omp, {})).items!.map(i => i.text)).toEqual(['first', 'second'])
    expect((await t.chat(omp, { from: 0 })).items!.map(i => i.text)).toEqual(['first', 'second'])
  })
})

describe('Codex with a shared daemon (session hook reported to the wrong pane)', () => {
  // Three Codex in the same folder; the app-server daemon, started by the first,
  // reports the third one's session to the first pane.
  const home = mkdtempSync(path.join(tmpdir(), 'hw-codex-'))
  const now = new Date()
  const dir = path.join(home, '.codex/sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  mkdirSync(dir, { recursive: true })
  const T = now.getTime() - 3 * 3600000
  const born = { a: T, b: T + 3600000, c: T + 3600000 + 200000 }
  const roll = (id: string, ts: number) => writeFileSync(path.join(dir, `rollout-x-${id}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id, timestamp: new Date(ts).toISOString(), cwd: '/repo', thread_source: 'user' },
  }) + '\n')
  roll('ra', born.a + 4000)
  roll('rb', born.b + 1000)
  roll('rc', born.c + 1000)
  roll('guardian', born.c + 1200) // not a main conversation: never chosen
  writeFileSync(path.join(dir, 'rollout-x-guardian.jsonl'), JSON.stringify({
    type: 'session_meta', payload: { id: 'guardian', parent_thread_id: 'rc', timestamp: new Date(born.c + 1200).toISOString(), cwd: '/repo', thread_source: 'guardian_review' },
  }) + '\n')
  const t = createTranscripts({ home, herdr: async () => { throw new Error('pas de Herdr') } })
  const a = { id: 'wA:p1', agent: 'codex', cwd: '/repo', agentSession: 'rc', bornAt: born.a }
  const b = { id: 'wB:p1', agent: 'codex', cwd: '/repo', agentSession: null, bornAt: born.b }
  const c = { id: 'wC:p1', agent: 'codex', cwd: '/repo', agentSession: null, bornAt: born.c }
  t.observe([a, b, c])

  it('attaches each Codex to the conversation born with it', async () => {
    expect((await t.locate(a))?.session).toBe('ra')
    expect((await t.locate(b))?.session).toBe('rb')
    expect((await t.locate(c))?.session).toBe('rc')
  })

  it('follows a reported session that belongs to no other pane (/new, resume)', async () => {
    roll('rnew', born.c + 600000)
    t.forget(a.id)
    expect((await t.locate({ ...a, agentSession: 'rnew' }))?.session).toBe('rnew')
  })
})

describe('Codex resumed conversations without a session hook', () => {
  const oldId = '01a15c41-b7d5-74d3-97e2-dff010dfdda8'
  const newId = '01a18706-8e7e-7063-8a6d-0ca13e80f862'
  function setup(args = ['codex', 'resume', oldId]) {
    const home = mkdtempSync(path.join(tmpdir(), 'hw-codex-resume-'))
    const now = Date.now()
    const write = (id: string, ts: number, mtime: number, text: string) => {
      const date = new Date(ts)
      const dir = path.join(home, '.codex/sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'))
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `rollout-test-${id}.jsonl`)
      writeFileSync(file, [
        { type: 'session_meta', payload: { id, cwd: '/repo', timestamp: date.toISOString(), thread_source: 'user' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      ].map(v => JSON.stringify(v)).join('\n') + '\n')
      utimesSync(file, new Date(mtime), new Date(mtime))
      return file
    }
    const old = write(oldId, now - 9 * 86400000, now - 1000, 'Existing conversation is still here.')
    const pane = { id: 'w1:p1', agent: 'codex', cwd: '/repo', agentSession: null, bornAt: now - 120000 }
    const herdr = async () => ({ process_info: { foreground_processes: [{ name: 'codex', argv: args }] } })
    const t = createTranscripts({ home, herdr })
    return { t, pane, old, write, now }
  }

  it('reads the explicit resumed transcript even when it predates the pane and recent directories', async () => {
    const { t, pane, old } = setup()
    expect(await t.locate(pane)).toEqual({ file: old, session: oldId })
    const response = await t.chat(pane, {})
    expect(response.available).toBe(true)
    expect(response.items?.map(i => i.text)).toEqual(['Existing conversation is still here.'])
  })

  it('keeps the recent conversation claimed by another pane separate', async () => {
    const { t, pane, old, write, now } = setup()
    write(newId, now - 60000, now, 'Another pane.')
    t.observe([pane, { ...pane, id: 'w1:p2', bornAt: now - 60000 }])
    expect(await t.locate(pane)).toEqual({ file: old, session: oldId })
  })

  it('can follow /new instead of permanently pinning the resumed launch session', async () => {
    const { t, pane, write, now } = setup()
    const file = write(newId, now - 5000, now, 'A new conversation.')
    expect(await t.locate(pane)).toEqual({ file, session: newId, guessed: true })
  })

  it('does not treat the prompt after --last as an explicit session id', async () => {
    const { t, pane } = setup(['codex', 'resume', '--last', oldId])
    expect(await t.locate(pane)).toBeNull()
  })
})

describe('/clear', () => {
  const j = (o: object) => JSON.stringify(o)
  const u = (content: string, ts: string) => j({ type: 'user', timestamp: ts, message: { role: 'user', content } })
  it('"Conversation effacée" separator, without attached output', () => {
    const items = parseLines([
      u('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>', '2026-01-01T00:00:00Z'),
      u('<local-command-stdout>✔ Update installed · Restart to update</local-command-stdout>', '2026-01-01T00:00:01Z'),
      j({ type: 'system', subtype: 'local_command', timestamp: '2026-01-01T00:00:02Z', content: '<command-name>/new</command-name><command-args></command-args>' }),
      j({ type: 'system', subtype: 'local_command', timestamp: '2026-01-01T00:00:03Z', content: '<local-command-stdout>(no content)</local-command-stdout>' }),
      u('<command-name>/compact</command-name><command-args></command-args>', '2026-01-01T00:00:04Z'),
      u('<local-command-stdout>Compacted</local-command-stdout>', '2026-01-01T00:00:05Z'),
    ].join('\n'), 'claude')
    expect(items.map(i => `${i.role}:${i.text}`)).toEqual(['system:Conversation cleared', 'system:Conversation cleared', 'cmd:/compact'])
    expect(items.some(i => i.out)).toBe(false)
  })
})

describe('"/" commands', () => {
  const j = (o: object) => JSON.stringify(o)
  const u = (content: unknown, ts: string, extra = {}) => j({ type: 'user', timestamp: ts, message: { role: 'user', content }, ...extra })
  const a = (text: string, ts: string) => j({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const cmd = (name: string, args = '') => `<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`
  const run = (lines: string[]) => parseLines(lines.join('\n'), 'claude').map(i => `${i.role}:${i.text}${i.out ? `|${i.out}` : ''}`)

  it('skill followed by a reply: normal user message, without screen output', () => {
    expect(run([
      u(cmd('/daily-log', 'hier'), '2026-01-01T00:00:00Z'),
      u('<local-command-stdout>Running 1 shell command…\n* Working… (1s · ↓ 113 tokens · thinking)\nTip: use /help</local-command-stdout>', '2026-01-01T00:00:01Z'),
      u([{ type: 'text', text: 'Base directory for this skill: /x' }], '2026-01-01T00:00:01Z', { isMeta: true }),
      a('Voici le journal.', '2026-01-01T00:00:02Z'),
    ])).toEqual(['user:/daily-log hier', 'assistant:Voici le journal.'])
  })

  it('local command: system line with the useful output only', () => {
    expect(run([
      u(cmd('/cost'), '2026-01-01T00:00:00Z'),
      u('<local-command-stdout>Total cost: $0.12\nTotal duration: 3m</local-command-stdout>', '2026-01-01T00:00:01Z'),
      u(cmd('/status'), '2026-01-01T00:00:02Z'),
      u('<local-command-stdout>* Working… (1s)\nTip: press ?</local-command-stdout>', '2026-01-01T00:00:03Z'),
      a('Rien à voir.', '2026-01-01T00:00:10Z'),
    ])).toEqual(['cmd:/cost → Total cost: $0.12', 'user:/status', 'assistant:Rien à voir.'])
  })

  it('"!" command: keeps its block and its real output', () => {
    expect(run([
      u('<bash-input>ls</bash-input>', '2026-01-01T00:00:00Z'),
      u('<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>', '2026-01-01T00:00:01Z'),
    ])).toEqual(['bash:ls|a.txt'])
  })
})

describe('Claude narration stored in a thinking block', () => {
  const line = (o: object) => JSON.stringify(o)
  const lines = [
    line({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Is the cache size fine?' } }),
    line({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { id: 'm1', role: 'assistant', content: [
      { type: 'thinking', thinking: '' },
      { type: 'thinking', thinking: 'Checked: the cache keeps files as they are.' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'du -sh cache', description: 'Measure cache' } },
    ] } }),
    line({ type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '12M cache' }] } }),
    line({ type: 'assistant', timestamp: '2026-01-01T00:00:03Z', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'The cache is 12 MB.' }] } }),
  ].join('\n') + '\n'

  it('shows the narration in order and hides empty thinking', () => {
    const items = parseLines(lines, 'claude', 0, HOME)
    const seq = items.map(i => i.role)
    expect(seq.filter(r => r === 'assistant')).toHaveLength(2)
    const texts = items.filter(i => i.role === 'assistant').map(i => i.text)
    expect(texts).toEqual(['Checked: the cache keeps files as they are.', 'The cache is 12 MB.'])
    const user = seq.indexOf('user')
    const narration = items.findIndex(i => i.text === 'Checked: the cache keeps files as they are.')
    const tool = seq.indexOf('tool')
    expect(user).toBeLessThan(narration)
    expect(narration).toBeLessThan(tool)
  })
})


describe('user paragraph spacing', () => {
  const text = 'First paragraph.\n\nSecond paragraph.\n\n\nThird paragraph.'
  const cases = [
    ['claude', { type: 'user', message: { role: 'user', content: text } }],
    ['claude', { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }],
    ['claude', { type: 'user', message: { role: 'user', content: `<pasted_content id="example">\n${text}\n</pasted_content id="example">` } }],
    ['codex', { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }],
    ['omp', { type: 'message', message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user' } }],
  ] as const

  it.each(cases)('%s preserves every internal newline', (kind, line) => {
    expect(parseLines(JSON.stringify(line), kind).find(i => i.role === 'user')?.text).toBe(text)
  })
})
