import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { fixture, startCore, type Call } from './core'

// OpenCode journey on the fake core: a live opencode process selects its
// session fail-closed out of the bounded /proc wire and the catalog wire,
// then the Conversation view renders the verified snapshot pages — user,
// assistant, a tool call — and a newer message lands on a later poll.
// Every machine.exec answer below is a synthetic wire (no scripts run);
// fingerprints are the helpers' own formula so the assembly checks them.
const WORK = '/workspace/demo'
const HOME_DIR = '/home/user'
const SERVER = 'a1b2c3d4'.repeat(4)
const OC_TERM = {
  address: 'host-a/t7', name: 'demo-opencode', cwd: WORK, state: 'live', template: 'opencode',
  labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbA' },
  argv: ['opencode'], created_ms: 1700000050000, screen: 'exact', cols: 80, rows: 24, status: null,
}
const T0 = 1700000060000
const enc = (x: string | Buffer) => ({ code: 0, stdout: Buffer.from(x).toString('base64'), stderr: '' })
const b64 = (x: string) => Buffer.from(x).toString('base64')
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

// The helper's canon() and its fingerprint serialization, test-side (ASCII
// fixtures only): canon feeds sha256 piecewise, the outer json.dumps list
// puts ", " between elements.
const canon = (v: unknown): string =>
  v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v)
    : typeof v === 'number' || typeof v === 'boolean' ? JSON.stringify(v)
      : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
        : '{' + Object.keys(v as object).sort().map(k => canon(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}'
const snapFp = (server: string, session: string, op: string, cursor: string, digest: string) =>
  sha('[' + [server, session, op, cursor, digest].map(s => JSON.stringify(s)).join(', ') + ']')

// One snapshot the helpers could have produced: canonical bytes of `body`,
// its meta envelope and the piece answers at any requested offset.
function snapshot(body: unknown, session: string) {
  const bytes = Buffer.from(canon(body))
  const fpOf = (op: string, cursor: string) => snapFp(SERVER, session, op, cursor, sha(bytes))
  return {
    meta: (req: Record<string, unknown>) => {
      const cursor = typeof req.cursor === 'string' ? req.cursor : ''
      const fingerprint = fpOf(String(req.op), cursor)
      return { status: 200, server: SERVER, fingerprint, size: bytes.length, unchanged: req.expect === fingerprint }
    },
    chunk: (req: Record<string, unknown>) => {
      const offset = Number(req.offset)
      const cursor = typeof req.cursor === 'string' ? req.cursor : ''
      return { status: 200, server: SERVER, fingerprint: fpOf(String(req.op), cursor), size: bytes.length, offset, piece: bytes.subarray(offset, offset + 4 * 1024 * 1024).toString('base64') }
    },
  }
}

const userMsg = (id: string, text: string, t: number) => ({ id, type: 'user', text, time: { created: t } })
const asstMsg = (id: string, parts: unknown[], t: number) => ({ id, type: 'assistant', time: { created: t }, content: parts })

// Session/detail bodies and the descending first page; the later update is
// the same conversation with one appended message (the page regrows).
const sessionBody = { data: { id: 'ses_1', title: 'demo', location: { directory: WORK }, time: { created: T0 - 9000, updated: T0 }, model: { id: 'acme-7' } } }
const pageV1 = { data: [
  asstMsg('m3', [{ type: 'text', text: 'Done.' }, { type: 'tool', id: 'call_1', name: 'bash', state: { input: { command: 'echo hi' }, content: 'hi\n', status: 'completed' }, time: { created: T0 + 900, completed: T0 + 1200 } }], T0 + 1000),
  asstMsg('m2', [{ type: 'reasoning', text: 'A greeting is asked.' }, { type: 'text', text: 'hello there' }], T0 + 500),
  userMsg('m1', 'say hi', T0),
], cursor: {} }
const pageV2 = { data: [asstMsg('m4', [{ type: 'text', text: 'updated reply lands live' }], T0 + 2000), ...pageV1.data], cursor: {} }

// The /proc wire the scan could emit for this machine: header, one classified
// row for pid 4242 (opencode, cwd WORK, born ~t=1700000050), trailer, all
// consistent with birthUpperBound(hz=100, boot=1700000000, up=100, wall).
const SCAN = [
  'H 100 1700000000 1',
  `S 4242 5000 100.0 1700000100.0 ${b64(WORK)} ${b64('opencode\0')} 1`,
  'T 1 1 0 0',
].join('\n') + '\n'
const CATALOG_ROW = { id: 'ses_1', parent: null, fork: null, title: 'demo', directory: WORK, subpath: null, created: T0 - 9000, updated: T0, viewed: null, idle: null, archived: null }

test('opencode journey: fail-closed selection renders a live read-only conversation', async ({ page }) => {
  const catalogReply = { status: 200, server: SERVER, fingerprint: 'c'.repeat(64), directory: WORK, pages: 1, size: canon([CATALOG_ROW]).length, rows: [CATALOG_ROW], exhausted: true, consistency: 'unproven' }
  let session = snapshot(sessionBody, 'ses_1')
  let page1 = snapshot(pageV1, 'ses_1')

  const exec = (c: Call) => {
    const a = c.params?.argv
    if (!Array.isArray(a) || a[0] !== 'sh' || a[1] !== '-c') return { code: 2, stdout: '', stderr: b64('fake core: unsupported argv') }
    const script = String(a[2]); const args = a.slice(4).map(String)
    if (script === 'printf %s "$HOME"') return enc(HOME_DIR)
    if (script.includes('CLK_TCK')) return enc(SCAN)
    if (script.startsWith('if stat')) return enc(args.map(() => 'x').join('\n') + '\n')
    if (script.includes('python3')) {
      const py = String(a[4]); const req = JSON.parse(String(a[6]))
      if (py.includes('CATALOG_PAGES')) return enc(JSON.stringify(catalogReply) + '\n')
      if (py.includes('PIECE_LIMIT')) return enc(JSON.stringify((req.op === 'page' ? page1 : session).chunk(req)) + '\n')
      return enc(JSON.stringify((req.op === 'page' ? page1 : session).meta(req)) + '\n')
    }
    return { code: 2, stdout: '', stderr: b64(`fake core: unhandled exec ${script.slice(0, 60)}`) }
  }

  const core = await startCore(call =>
    call.method === 'terminal.list' ? { ...fixture.inventory, terminals: [OC_TERM] }
    : call.method === 'events.subscribe' ? { channel: 2, seq: 1, terminals: [OC_TERM] }
    : call.method === 'doc.get' ? { value: call.params.on ? null : { spaces: [{ id: 'sp1', name: 'Demo', folder: WORK, tabs: [{ id: 'tbA', name: 'Main' }] }] }, version: 1 }
    : call.method === 'terminal.get' && call.params.terminal === OC_TERM.address
      ? { state: 'live', pid: 4242, argv: ['opencode'], created_ms: 1700000050000,
          foreground: { pid: 4242, name: 'opencode', argv: ['opencode'], cwd: WORK } }
    : call.method === 'machine.exec' ? exec(call)
    : undefined)

  const chat = page.locator('.chat-list')
  const pollText = async (want: string) => expect.poll(async () => {
    await page.clock.runFor(7000)
    return (await chat.textContent()) ?? ''
  }, { timeout: 20_000 }).toContain(want)

  try {
    await page.clock.install()
    await core.open(page)
    await expect(page.getByRole('button', { name: /demo-opencode/ }).first()).toBeVisible()
    await page.getByRole('button', { name: /demo-opencode/ }).first().click()
    const toChat = page.getByRole('button', { name: 'Conversation', exact: true })
    if (await toChat.count() && await toChat.getAttribute('aria-pressed') === 'false') await toChat.click()

    // Selection resolved: the verified page renders as a conversation —
    // user, reasoning, assistant text and the tool call with its outcome.
    await pollText('hello there')
    await expect(chat).toContainText('say hi')
    await expect(chat).toContainText('echo hi')
    await expect(chat).toContainText('Done.')
    // Read-only: no composer, no reply affordance over an OpenCode pane.
    await expect(page.locator('[data-wherdr="composer-field"]')).toHaveCount(0)
    await expect(page.locator('.msg-reply:not(.read-aloud)')).toHaveCount(0)

    // A newer message on the service lands on the next live poll.
    page1 = snapshot(pageV2, 'ses_1')
    await pollText('updated reply lands live')
  } finally {
    await core.stop()
  }
})
