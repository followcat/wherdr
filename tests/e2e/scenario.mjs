// The fake session the end-to-end tests run against: its panes, and the
// neutral transcripts written into the fake HOME. Shared by the launcher and the specs.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { samplePdf } from './samplePdf.mjs'

export const PORT = Number(process.env.E2E_PORT || 7699)
export const BASE_URL = `http://127.0.0.1:${PORT}`

// Path of the fake Herdr's socket, written by the launcher.
export const SOCK_FILE = path.join(process.env.E2E_TMP_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.e2e-tmp'), 'herdr-sock')

// A call to the fake Herdr from a spec (its state, e.g. `e2e.pane_size`).
export function fakeHerdr(method, params = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(fs.readFileSync(SOCK_FILE, 'utf8'))
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('error', reject)
    conn.on('connect', () => conn.write(JSON.stringify({ id: 'spec', method, params }) + '\n'))
    conn.on('data', (chunk) => { buf += chunk })
    conn.on('end', () => {
      try {
        const res = JSON.parse(buf)
        if (res.error) reject(new Error(res.error.message))
        else resolve(res.result)
      } catch (e) { reject(e) }
    })
  })
}

// Pane ids (Herdr format <workspace>:<pane>).
export const CLAUDE_PANE = 'w1:p1'
export const OMP_LONG_PANE = 'w2:p1'
export const OMP_CHAT_PANE = 'w3:p1'
export const OMP_IMAGE_PANE = 'w4:p1'
// A file named in the image pane's last reply, in its folder (CRLF kept as is).
export const REVIEW_CSV = 'notes/login-review.csv'
export const REVIEW_CSV_TEXT = 'screen,issue\r\nlogin,clipped button\r\n'
// A multipage PDF next to it, generated for the canvas preview tests.
export const SAMPLE_PDF = 'notes/style-guide.pdf'
export const SAMPLE_PDF_PAGES = Array.from({ length: 12 }, (_, i) => `Style guide page ${i + 1}`)
// Two-second test-pattern videos (160×90, no audio) for the video player:
// WebM (VP8) plays in every test browser, MP4 (H.264) where the codec exists.
export const SAMPLE_WEBM = 'notes/walkthrough.webm'
export const SAMPLE_MP4 = 'notes/walkthrough.mp4'
// Named as a video, but a page: never served inline.
export const FAKE_MOV = 'notes/fake-clip.mov'
export const fixture = name => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name))
export const OMP_APPROVAL_PANE = 'w5:p1'
export const OMP_SHELL_PANE = 'w6:p1'
// Coordinator of a herdr-projects project (its board is served by the spec).
export const COORDINATOR_PANE = 'w7:p1'
// omp replies with questions in the middle of their paragraphs.
export const OMP_QUESTIONS_PANE = 'w8:p1'
// A Space with two panes side by side: an omp conversation and a shell.
export const SPLIT_TAB = 'w9:t1'
export const SPLIT_CHAT_PANE = 'w9:p1'
export const SPLIT_SHELL_PANE = 'w9:p2'
export const CODEX_UPDATE_PANE = 'w10:p1'
// Two agents at rest that a spec makes wait on a question (e2e.ask).
export const OMP_ASK_PANE = 'w11:p1'
export const CLAUDE_ASK_PANE = 'w12:p1'
// A coordinator's decision table (numbered questions), next to a plain table.
export const OMP_DECISIONS_PANE = 'w13:p1'
// An agent whose every reply ends with a question (the unanswered reminder).
export const OMP_FOLLOWUP_PANE = 'w14:p1'
export const FOLLOWUP_REPLY = 'Noted. Shall I go on with the next step?'
// A reply in French that asks one closed question.
export const OMP_FRENCH_PANE = 'w15:p1'
// A decision table the agent has written other messages after.
export const OMP_OLD_TABLE_PANE = 'w16:p1'
// One message with two decision tables whose first rows ask the same thing.
export const OMP_TWO_TABLES_PANE = 'w17:p1'
// Claude at rest with its grayed-out suggestion in the field: after two questions, then after none.
export const CLAUDE_SUGGEST_ASK_PANE = 'w18:p1'
export const CLAUDE_SUGGEST_PANE = 'w19:p1'
export const SUGGEST_ASK = 'yes add the teardown and check both'
export const SUGGEST_PLAIN = 'run the nightly build again'
export const CODEX_UPDATE_SESSION = '00000000-0000-4000-8000-000000000288'

// Unique markers of the long omp transcript (asserted on by the specs).
export const LONG_WORD = `Pneumono${'ultramicroscopicsilicovolcano'.repeat(12)}coniosis`
export const LONG_URL = `https://example.com/acme-api/releases/${'nested-segment/'.repeat(24)}changelog.html?ref=${'abcdef0123456789'.repeat(6)}`
export const LONG_END = 'End of the long build report.'

const iso = ts => new Date(ts).toISOString()

// A 240×150 gradient PNG: the image an omp `read` returns in the image scenario.
export function gradientPng(w = 240, h = 150) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xFFFFFFFF
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = Math.round(255 * x / w)
      raw[o + 1] = Math.round(255 * y / h)
      raw[o + 2] = 160
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n'

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

// A pasted install log (Claude wraps a paste in <pasted_content>) and a long
// typed message: shown as a "Pasted text" card and a folded bubble.
export const PASTED_LOG = Array.from({ length: 40 }, (_, i) => `==> Pouring libexample-${i}--2.1.0.arm64_sonoma.bottle.tar.gz`).join('\n')
// Ten lines written in wherdr's field (references to the agent's points, each
// with an answer): Claude wraps a multi-line send whole in <pasted_content>,
// and it is still a plain message.
export const TYPED_QUOTES = Array.from({ length: 5 }, (_, i) =>
  `↳ Quote point 09:0${i} : Point ${i + 1}: ${'the cache entry is kept after an update and should expire. '.repeat(5).trim()} —\nAnswer ${i + 1}: agreed, go ahead with that one.`).join('\n')
export const LONG_TYPED = Array.from({ length: 24 }, (_, i) => `Step ${i + 1}: check the cache entry again.`).join('\n')

// Claude Code: ~/.claude/projects/<cwd with / and . as ->/<session id>.jsonl.
function claudeTranscript(home, cwd, sid, now) {
  const enc = cwd.replace(/[/.]/g, '-')
  const file = path.join(home, '.claude/projects', enc, `${sid}.jsonl`)
  const base = { isSidechain: false, cwd, sessionId: sid }
  write(file, jsonl([
    { ...base, type: 'user', timestamp: iso(now - 60000), message: { role: 'user', content: 'After updating a user, GET /users/:id still returns the old name. Find out why.' } },
    { ...base, type: 'assistant', timestamp: iso(now - 50000), message: { model: 'claude-opus-4-1', role: 'assistant', content: [{ type: 'text', text: '`getUser` caches users forever and `updateUser` never clears the entry. I will add an expiry and clear it on update.' }] } },
    { ...base, type: 'user', timestamp: iso(now - 40000), message: { role: 'user', content: `The install fails, here is the log:\n\n<pasted_content id="a1f2">\n${PASTED_LOG}\n</pasted_content id="a1f2">` } },
    { ...base, type: 'assistant', timestamp: iso(now - 35000), message: { model: 'claude-opus-4-1', role: 'assistant', content: [{ type: 'text', text: 'The bottle is fine; the link step fails.' }] } },
    { ...base, type: 'user', timestamp: iso(now - 33000), message: { role: 'user', content: `<pasted_content id="b7c3">\n${TYPED_QUOTES}\n</pasted_content id="b7c3">` } },
    { ...base, type: 'assistant', timestamp: iso(now - 32000), message: { model: 'claude-opus-4-1', role: 'assistant', content: [{ type: 'text', text: 'Understood, point by point.' }] } },
    { ...base, type: 'user', timestamp: iso(now - 30000), message: { role: 'user', content: LONG_TYPED } },
    { ...base, type: 'assistant', timestamp: iso(now - 25000), message: { model: 'claude-opus-4-1', role: 'assistant', content: [{ type: 'text', text: 'All steps noted.' }] } },
  ]))
}

// Claude Code's idle field holding its suggestion, as tests/fixtures/claude-suggestion.ansi.
const CLAUDE_RULE = `\x1b[0m\x1b[38;2;136;136;136m${'─'.repeat(60)}\x1b[0m`
const claudeSuggestionScreen = text => ['', CLAUDE_RULE, `❯\u00a0 \x1b[0m\x1b[2m${text}\x1b[0m`, CLAUDE_RULE, '  ? for shortcuts'].join('\r\n')
function claudeChat(home, cwd, sid, now, turns) {
  const file = path.join(home, '.claude/projects', cwd.replace(/[/.]/g, '-'), `${sid}.jsonl`)
  const base = { isSidechain: false, cwd, sessionId: sid }
  write(file, jsonl(turns.map(([role, text], i) => ({
    ...base, type: role, timestamp: iso(now - 60000 + i * 10000),
    message: role === 'user' ? { role, content: text } : { model: 'claude-opus-4-1', role, content: [{ type: 'text', text }] },
  }))))
}

// omp: ~/.omp/agent/sessions/<encoded cwd>/<date>_<id>.jsonl.
function ompTranscript(home, cwd, id, now, entries) {
  const enc = `-${cwd.replace(/^\//, '').replace(/[/.]/g, '-')}-`
  const file = path.join(home, '.omp/agent/sessions', enc, `${iso(now - 120000).replace(/[:.]/g, '-')}_${id}.jsonl`)
  let t = now - 120000
  const msg = (message) => {
    t += 1000
    return { type: 'message', id: `m${t}`, timestamp: iso(t), message: { ...message, timestamp: t } }
  }
  write(file, jsonl([{ type: 'session', version: 3, id, timestamp: iso(now - 120000), cwd }, ...entries(msg)]))
  return file
}

function longContent(msg) {
  const wideCode = `const endpoints = [${Array.from({ length: 14 }, (_, i) => `'/v1/resources/${i}/sub-resources/details'`).join(', ')}]`
  const head = '| Endpoint | Method | Median latency | p99 latency | Error rate | Owner team | Notes |'
  const sep = '|---|---|---|---|---|---|---|'
  const rows = Array.from({ length: 5 }, (_, i) =>
    `| /v1/resources/${i}/sub-resources/details-with-a-long-name | GET | ${12 + i} ms | ${140 + i} ms | 0.0${i} % | platform-reliability-and-observability | cached-response-without-invalidation-${i} |`)
  const toolOut = Array.from({ length: 40 }, (_, i) =>
    `[build] step ${String(i + 1).padStart(2, '0')}/40 ${'compiling-module-with-a-very-long-identifier/'.repeat(6)}index.ts ok`).join('\n')
  return [
    msg({ role: 'user', content: [{ type: 'text', text: 'Run the build and summarize the endpoints report.' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-build', name: 'bash', arguments: { i: 'Running the verbose build', command: `npm run build -- --verbose --filter=${'packages/acme-api-'.repeat(8)}core` } }], stopReason: 'toolUse' }),
    msg({ role: 'toolResult', toolCallId: 'call-build', toolName: 'bash', content: [{ type: 'text', text: `${toolOut}\n\nWall time: 4.20 seconds` }], details: { wallTimeMs: 4200 }, isError: false }),
    msg({
      role: 'assistant',
      stopReason: 'stop',
      content: [{
        type: 'text',
        text: [
          `The build passes. One unbroken token from the log: ${LONG_WORD}`,
          `Full report: ${LONG_URL}`,
          '```js', wideCode, '```',
          head, sep, ...rows,
          '',
          LONG_END,
        ].join('\n\n').replace(/\n\n(?=\|)/g, '\n'),
      }],
    }),
  ]
}

// Writes the fake HOME and returns the workspaces served by the fake Herdr.
export function writeScenario(home) {
  const now = Date.now()
  const api = path.join(home, 'projects/acme-api')
  const docs = path.join(home, 'projects/docs-site')
  const demo = path.join(home, 'projects/demo')
  const screens = path.join(home, 'projects/screens')
  const approval = path.join(home, 'projects/approval')
  const scratch = path.join(home, 'projects/scratch')
  const coordinator = path.join(home, '.herdr-projects/acme')
  const questions = path.join(home, 'projects/questions')
  const split = path.join(home, 'projects/split')
  const release = path.join(home, 'projects/release')
  const billing = path.join(home, 'projects/billing')
  const decisions = path.join(home, 'projects/decisions')
  const followup = path.join(home, 'projects/followup')
  const french = path.join(home, 'projects/fusion')
  const oldTable = path.join(home, 'projects/earlier')
  const twoTables = path.join(home, 'projects/rollout')
  const teardown = path.join(home, 'projects/teardown')
  const nightly = path.join(home, 'projects/nightly')
  const codex = path.join(home, '.herdr-projects/codex-update')
  fs.mkdirSync(codex, { recursive: true })
  for (const d of [api, docs, demo, screens, approval, scratch, coordinator, questions, split, release, billing, decisions, followup, french, oldTable, twoTables, teardown, nightly]) fs.mkdirSync(d, { recursive: true })

  const claudeSid = '00000000-0000-4000-8000-000000000001'
  const codexFile = path.join(home, `.codex/sessions/${new Date().toISOString().slice(0, 10).replaceAll('-', '/')}/rollout-test-${CODEX_UPDATE_SESSION}.jsonl`)
  write(codexFile, jsonl([
    { type: 'session_meta', payload: { id: CODEX_UPDATE_SESSION, cwd: codex, timestamp: iso(now - 60000), thread_source: 'user' } },
    { type: 'response_item', timestamp: iso(now - 50000), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the build.' }] } },
    { type: 'response_item', timestamp: iso(now - 40000), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The build passes.' }] } },
  ]))
  claudeTranscript(home, api, claudeSid, now)
  const teardownSid = '00000000-0000-4000-8000-000000000018'
  claudeChat(home, teardown, teardownSid, now, [
    ['user', 'The integration tests leave containers behind. Can you fix it?'],
    ['assistant', 'The fixtures start a database but never stop it.\n\nShall I add a teardown to the shared fixture?\n\nShould I also check the two CI builds afterwards?'],
  ])
  const nightlySid = '00000000-0000-4000-8000-000000000019'
  claudeChat(home, nightly, nightlySid, now, [
    ['user', 'Why did the nightly build fail?'],
    ['assistant', 'A flaky network test timed out; the rest passed.'],
  ])
  const longFile = ompTranscript(home, docs, 'e2e-long', now, longContent)
  const chatFile = ompTranscript(home, demo, 'e2e-chat', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'Are you ready?' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'Ready when you are.' }], stopReason: 'stop' }),
  ])
  // An omp `read` of a PNG, then enough calls to fold it out of the console.
  const png = gradientPng()
  const hash = crypto.createHash('sha256').update(png).digest('hex')
  write(path.join(home, '.omp/agent/blobs', hash), png)
  const imageFile = ompTranscript(home, screens, 'e2e-image', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'Check the login screenshot.' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-read', name: 'read', arguments: { i: 'Reading the screenshot', path: `${screens}/login.png` } }], stopReason: 'toolUse' }),
    msg({ role: 'toolResult', toolCallId: 'call-read', toolName: 'read', content: [{ type: 'text', text: '' }, { type: 'image', mimeType: 'image/png', data: `blob:sha256:${hash}` }] }),
    ...['ls', 'git status', 'npm test'].flatMap((command, k) => [
      msg({ role: 'assistant', content: [{ type: 'toolCall', id: `call-${k}`, name: 'bash', arguments: { command } }], stopReason: 'toolUse' }),
      msg({ role: 'toolResult', toolCallId: `call-${k}`, toolName: 'bash', content: [{ type: 'text', text: 'ok' }] }),
    ]),
    msg({ role: 'assistant', content: [{ type: 'text', text: `The login button is clipped.\n\nThe review is in \`${REVIEW_CSV}\`.` }], stopReason: 'stop' }),
  ])
  // The file that reply names, previewed and downloaded from the conversation.
  write(path.join(screens, REVIEW_CSV), REVIEW_CSV_TEXT)
  write(path.join(screens, SAMPLE_PDF), samplePdf(SAMPLE_PDF_PAGES))
  write(path.join(screens, SAMPLE_WEBM), fixture('sample.webm'))
  write(path.join(screens, SAMPLE_MP4), fixture('sample.mp4'))
  // Settled, sub-second times: the videos get a strong ETag (If-Range).
  for (const f of [SAMPLE_WEBM, SAMPLE_MP4]) fs.utimesSync(path.join(screens, f), 1767225600.25, 1767225600.25)
  write(path.join(screens, FAKE_MOV), '<html><script>alert(1)</script>\n')
  const coordinatorFile = ompTranscript(home, coordinator, 'e2e-coordinator', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'Where are the threads?' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'Two threads are working.' }], stopReason: 'stop' }),
  ])
  // Questions followed by other sentences, in English and in French, next to
  // what must not get a "Reply" button (code, a URL, quoted words, a title);
  // then a list of points, an introduction and a closing question.
  const questionsFile = ompTranscript(home, questions, 'e2e-questions', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'Plan the release.' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: [
      '## What is left? A summary',
      'I added the task to the queue, to be confirmed. Shall I start step 1 now? A slot is free on the server.',
      'Shall I tag the release today? The build is green. Or do you want a review first? Both are fine with me.',
      'You asked "can it be faster?" earlier. The page is at https://example.com/search?x=1 and `ready ? 1 : 0` stays as it is.',
    ].join('\n\n') }], stopReason: 'stop' }),
    msg({ role: 'user', content: [{ type: 'text', text: 'Et en français ?' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: [
      'J’ai noté la tâche dans « En file », à valider. Je lance l’étape 1 maintenant ? Une place est libre sur le serveur.',
      'Tu as demandé « on peut aller plus vite ? » hier. C’est fait.',
      'Dernier point : je publie les notes de version ?',
    ].join('\n\n') }], stopReason: 'stop' }),
    msg({ role: 'user', content: [{ type: 'text', text: 'Anything to note?' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: [
      'Three things to note:',
      '- The cache is cleared on every deploy.\n- The export keeps its old column order.\n- The limits come from `req.plan.limits`.',
      'All 48 tests pass. Shall I merge the branch now?',
    ].join('\n\n') }], stopReason: 'stop' }),
  ])
  // A decision table to answer row by row; the table of threads above it and
  // the numbered table of files below it are not ones.
  const decisionsFile = ompTranscript(home, decisions, 'e2e-decisions', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'What do you need from me?' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: [
      'Two threads are done:',
      '| Thread | State |\n| --- | --- |\n| t-0001 | merged |\n| t-0002 | in review |',
      'Four decisions are waiting for you:',
      '| # | Question | My advice |\n| --- | --- | --- |\n| 1 | Tag the release **today**? | Yes |\n| 2 | Keep the old export format for one more version? | No |\n| 3 | Publish the release notes on the site? | Yes |\n| 4 | Which name for the new theme? | Titanium |',
      'The build output, for reference:',
      '| # | File | Size |\n| --- | --- | --- |\n| 1 | main.css | 120 kB |\n| 2 | app.js | 300 kB |',
      'Shall I start the next thread meanwhile?',
    ].join('\n\n') }], stopReason: 'stop' }),
  ])
  const followupFile = ompTranscript(home, followup, 'e2e-followup', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'Review the plan.' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'An earlier point. Was the first draft fine?' }], stopReason: 'stop' }),
    msg({ role: 'user', content: [{ type: 'text', text: 'Go on.' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'The plan has two open points. Shall I rename the module? It is a small change.\n\nWhich name do you prefer?' }], stopReason: 'stop' }),
  ])
  const frenchFile = ompTranscript(home, french, 'e2e-french', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'Où en est la fusion ?' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'Les 48 tests passent et la revue est faite.\n\nJe fusionne la branche maintenant ?' }], stopReason: 'stop' }),
  ])
  const oldTableFile = ompTranscript(home, oldTable, 'e2e-old-table', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'What is waiting for me?' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: [
      'Three decisions are waiting for you:',
      '| # | Question | My advice |\n| --- | --- | --- |\n| 1 | Drop the legacy importer? | Yes |\n| 2 | Move the nightly job to 02:00 — after the backup? | Yes |\n| 3 | Rename the public API field? | No |',
      'Take your time.',
    ].join('\n\n') }], stopReason: 'stop' }),
    msg({ role: 'user', content: [{ type: 'text', text: 'Give me a minute.' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'Sure. Meanwhile the docs build finished.\n\nShall I delete the old staging database?' }], stopReason: 'stop' }),
  ])
  const twoTablesFile = ompTranscript(home, twoTables, 'e2e-two-tables', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'What about the rollout?' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: [
      'Staging first:',
      '| # | Question |\n| --- | --- |\n| 1 | Continue? |\n| 2 | Keep the staging data? |',
      'Then production (rows 2 and 3 are settled):',
      '| # | Question |\n| --- | --- |\n| 1 | Continue? |\n| 4 | Delete the old production replica? |',
    ].join('\n\n') }], stopReason: 'stop' }),
  ])
  // omp waiting for the approval of its first action (status "blocked").
  const approvalFile = ompTranscript(home, approval, 'e2e-approval', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'Clean the build folder.' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-rm', name: 'bash', arguments: { i: 'Removing the build folder', command: 'rm -rf build' } }], stopReason: 'toolUse' }),
  ])
  const splitFile = ompTranscript(home, split, 'e2e-split', now, msg => [
    msg({ role: 'user', content: [{ type: 'text', text: 'Is the dev server up?' }], attribution: 'user' }),
    msg({ role: 'assistant', content: [{ type: 'text', text: 'It runs in the pane on the right.' }], stopReason: 'stop' }),
  ])
  // "/" menu: a project skill and a project command for Claude, a project command for omp.
  write(path.join(api, '.claude/skills/daily-notes/SKILL.md'), '---\nname: daily-notes\ndescription: Write the daily notes of the project\n---\nSteps.\n')
  write(path.join(api, '.claude/commands/daily-check.md'), '# Check the daily build\n')
  write(path.join(demo, '.omp/commands/daily-sync.md'), '---\ndescription: Sync the daily branch\n---\nSync.\n')
  const ciPlugin = path.join(home, '.claude/plugins/cache/market/circleci/1.0')
  write(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'circleci@market': true } }))
  write(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'circleci@market': [{ scope: 'user', installPath: ciPlugin }],
  } }))
  write(path.join(ciPlugin, '.claude-plugin/plugin.json'), JSON.stringify({ skills: ['./custom/deploy'] }))
  write(path.join(ciPlugin, 'custom/deploy/SKILL.md'), '---\ndescription: Deploy the CI build\nargument-hint: <target>\n---\n')
  write(path.join(ciPlugin, 'skills/build/SKILL.md'), '---\nname: build\ndescription: Inspect the CI build\nargument-hint: <branch>\n---\n')
  write(path.join(ciPlugin, 'commands/config.md'), '---\ndescription: Validate CI configuration\n---\n')
  // In the .claude/ of a parent folder: Claude Code offers it in every project below.
  write(path.join(home, 'projects/.claude/commands/team-standup.md'), '---\ndescription: Prepare the team standup\n---\nStandup.\n')

  return [
    { id: 'w10', label: 'codex-update', panes: [{ id: CODEX_UPDATE_PANE, agent: 'codex', status: 'idle', cwd: codex, session: CODEX_UPDATE_SESSION, pid: 3001 }] },
    { id: 'w1', label: 'acme-api', panes: [{ id: CLAUDE_PANE, agent: 'claude', status: 'idle', cwd: api, session: claudeSid }] },
    { id: 'w2', label: 'docs-site', panes: [{ id: OMP_LONG_PANE, agent: 'omp', status: 'idle', cwd: docs, session: longFile }] },
    { id: 'w3', label: 'demo', panes: [{ id: OMP_CHAT_PANE, agent: 'omp', status: 'idle', cwd: demo, session: chatFile, transcript: chatFile, reply: 'Got it.', devinHome: home }] },
    { id: 'w4', label: 'screens', panes: [{ id: OMP_IMAGE_PANE, agent: 'omp', status: 'idle', cwd: screens, session: imageFile }] },
    { id: 'w5', label: 'approval', panes: [{ id: OMP_APPROVAL_PANE, agent: 'omp', status: 'blocked', cwd: approval, session: approvalFile }] },
    // A fresh omp (no transcript yet) that runs "!" commands.
    { id: 'w6', label: 'scratch', panes: [{ id: OMP_SHELL_PANE, agent: 'omp', status: 'idle', cwd: scratch, shell: true }] },
    { id: 'w7', label: 'acme', panes: [{ id: COORDINATOR_PANE, agent: 'omp', status: 'idle', cwd: coordinator, session: coordinatorFile, transcript: coordinatorFile, reply: 'Passed on.' }] },
    { id: 'w8', label: 'questions', panes: [{ id: OMP_QUESTIONS_PANE, agent: 'omp', status: 'idle', cwd: questions, session: questionsFile }] },
    { id: 'w9', label: 'split', panes: [
      { id: SPLIT_CHAT_PANE, agent: 'omp', status: 'idle', cwd: split, session: splitFile },
      { id: SPLIT_SHELL_PANE, status: 'idle', cwd: split },
    ] },
    { id: 'w11', label: 'release', panes: [{ id: OMP_ASK_PANE, agent: 'omp', status: 'idle', cwd: release }] },
    { id: 'w12', label: 'billing', panes: [{ id: CLAUDE_ASK_PANE, agent: 'claude', status: 'idle', cwd: billing }] },
    { id: 'w13', label: 'decisions', panes: [{ id: OMP_DECISIONS_PANE, agent: 'omp', status: 'idle', cwd: decisions, session: decisionsFile }] },
    { id: 'w14', label: 'followup', panes: [{ id: OMP_FOLLOWUP_PANE, agent: 'omp', status: 'idle', cwd: followup, session: followupFile, transcript: followupFile, reply: FOLLOWUP_REPLY }] },
    { id: 'w15', label: 'fusion', panes: [{ id: OMP_FRENCH_PANE, agent: 'omp', status: 'idle', cwd: french, session: frenchFile }] },
    { id: 'w16', label: 'earlier', panes: [{ id: OMP_OLD_TABLE_PANE, agent: 'omp', status: 'idle', cwd: oldTable, session: oldTableFile }] },
    { id: 'w17', label: 'rollout', panes: [{ id: OMP_TWO_TABLES_PANE, agent: 'omp', status: 'idle', cwd: twoTables, session: twoTablesFile }] },
    { id: 'w18', label: 'teardown', panes: [{ id: CLAUDE_SUGGEST_ASK_PANE, agent: 'claude', status: 'idle', cwd: teardown, session: teardownSid, customScreen: claudeSuggestionScreen(SUGGEST_ASK) }] },
    { id: 'w19', label: 'nightly', panes: [{ id: CLAUDE_SUGGEST_PANE, agent: 'claude', status: 'idle', cwd: nightly, session: nightlySid, customScreen: claudeSuggestionScreen(SUGGEST_PLAIN) }] },
  ]
}
