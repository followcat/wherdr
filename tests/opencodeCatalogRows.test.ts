import { expect, it } from 'vitest'
import { PY_COMMON } from '../server/utils/opencodeTransport'
import { CATALOG_ROW_RULES } from '../server/utils/opencodeCatalogRows'
import { localShell } from '../server/utils/agentProcesses'

// Direct parser contract for the shared reduced-row seam: a small fixed
// driver composed in-test runs the real row rules through localShell. No
// service, HOME or CLI stub is needed -- the parser is pure.
const DRIVER = PY_COMMON + CATALOG_ROW_RULES + String.raw`
try:
    raw = sys.argv[1] if len(sys.argv) > 1 else ''
    if len(raw.encode('utf-8', 'surrogateescape')) > 4096:
        raise Fail('invalid_request')
    try:
        item = json.loads(raw)
    except ValueError:
        raise Fail('invalid_request')
    emit({'row': catalog_row(item)})
except Fail as e:
    emit({'error': e.key})
    sys.exit(1)
except Exception:
    emit({'error': 'helper_error'})
    sys.exit(1)
`
const parse = async (item: unknown) => {
  const r = await localShell('exec python3 -X utf8 -c "$1" "$2"',
    [DRIVER, typeof item === 'string' ? item : JSON.stringify(item)], { timeoutMs: 15000, maxBytes: 8192 })
  return { code: r.code, out: JSON.parse(r.stdout.toString('utf8').trim()) }
}

const DIR = '/home/user/proj'
// A native session row as the service returns it; extra producer fields
// must be tolerated, reduced, never required.
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, parentID: null, title: `t-${id}`, location: { directory: DIR, extra: 1 },
  subpath: '', metadata: { ignored: true },
  time: { created: 1000, updated: 2000 }, ...over,
})

it('reduces valid native rows to the exact bounded shape', async () => {
  const full = await parse(row('ses_root'))
  expect(full.code).toBe(0)
  expect(full.out).toEqual({ row: { id: 'ses_root', parent: null, fork: null,
    title: 't-ses_root', directory: DIR, subpath: '', created: 1000, updated: 2000,
    viewed: null, idle: null, archived: null } })
  // Distinctions survive: child, fork, archived, idle/viewed, unicode title.
  const rich = await parse(row('ses_c', { parentID: 'ses_root',
    fork: { sessionID: 'ses_p', boundary: { i: 1 } }, subpath: 'sub/dir',
    title: 'caf\u00e9 \u201cchat\u201d', other: [1, 2],
    time: { created: 900, updated: 3000, viewed: 2500, idle: 2600, archived: 4000 } }))
  expect(rich.out).toEqual({ row: { id: 'ses_c', parent: 'ses_root', fork: 'ses_p',
    title: 'caf\u00e9 \u201cchat\u201d', directory: DIR, subpath: 'sub/dir',
    created: 900, updated: 3000, viewed: 2500, idle: 2600, archived: 4000 } })
  // A bare row still validates: absent optionals become null.
  const bare = await parse({ id: 'ses_min', location: { directory: '/x' },
    time: { created: 1, updated: 2 } })
  expect(bare.out).toEqual({ row: { id: 'ses_min', parent: null, fork: null,
    title: null, directory: '/x', subpath: null, created: 1, updated: 2,
    viewed: null, idle: null, archived: null } })
})

it('accepts fields at the byte boundary and hyphenated paths', async () => {
  // 1024-byte fields are the exact edge: ASCII and multibyte both pass.
  const wide = await parse(row('ses_edge', { title: 't'.repeat(1024) }))
  expect(wide.out.row?.title).toBe('t'.repeat(1024))
  const utf8 = await parse(row('ses_edge', { title: '\u00e9'.repeat(512) }))
  expect(utf8.out.row?.title).toBe('\u00e9'.repeat(512)) // 512 x 2 bytes = 1024
  // A proper surrogate pair decodes to one scalar and stays valid.
  const pair = await parse('{"id":"ses_pair","location":{"directory":"/x"},'
    + '"time":{"created":1,"updated":2},"title":"\\ud83d\\ude00"}')
  expect(pair.out.row?.title).toBe('\u{1f600}')
  const hyphen = await parse(row('ses_h', { location: { directory: '/home/user/proj-a' } }))
  expect(hyphen.out.row?.directory).toBe('/home/user/proj-a')
})

// Every malformed row is an explicit failure, never an omission.
const bad: [string, Record<string, unknown> | string | unknown[]][] = [
  ['item not dict', ['x'] as unknown[]],
  ['item scalar', '"x"'],
  ['id missing', { ...row('x'), id: undefined }],
  ['id not string', { ...row('ses_a'), id: 42 }],
  ['id bad brand', row('xx_a')],
  ['id too long', row(`ses_${'a'.repeat(200)}`)],
  ['parentID not id', row('ses_a', { parentID: 12 })],
  ['fork not object', row('ses_a', { fork: 'ses_x' })],
  ['fork missing sessionID', row('ses_a', { fork: { boundary: 1 } })],
  ['fork sessionID bad', row('ses_a', { fork: { sessionID: 'bad' } })],
  ['title not string', row('ses_a', { title: 5 })],
  ['title with NUL', row('ses_a', { title: 'has\0nul' })],
  ['title too long', row('ses_a', { title: 't'.repeat(1025) })],
  ['location missing', { ...row('ses_a'), location: undefined }],
  ['location not dict', row('ses_a', { location: 'x' })],
  ['dir not string', row('ses_a', { location: { directory: 1 } })],
  ['dir relative', row('ses_a', { location: { directory: 'relative' } })],
  ['dir with NUL', row('ses_a', { location: { directory: '/ok\0bad' } })],
  ['dir tab control', row('ses_a', { location: { directory: '/ok\tbad' } })],
  ['dir DEL control', row('ses_a', { location: { directory: '/ok\x7fbad' } })],
  ['dir too long', row('ses_a', { location: { directory: `/${'x'.repeat(1024)}` } })],
  ['dir lone surrogate', '{"id":"ses_a","location":{"directory":"/x\\ud800"},'
    + '"time":{"created":1,"updated":2}}'],
  ['subpath not string', row('ses_a', { subpath: 5 })],
  ['subpath with NUL', row('ses_a', { subpath: 'a\0b' })],
  ['title lone surrogate', '{"id":"ses_a","location":{"directory":"/x"},'
    + '"time":{"created":1,"updated":2},"title":"\\ud800"}'],
  ['title over 1024 utf8 bytes', row('ses_a', { title: '\u00e9'.repeat(513) })],
  ['time missing', { ...row('ses_a'), time: undefined }],
  ['time not dict', row('ses_a', { time: 'soon' })],
  ['created missing', row('ses_a', { time: { updated: 1 } })],
  ['created not number', row('ses_a', { time: { created: '1', updated: 1 } })],
  ['created bool', row('ses_a', { time: { created: true, updated: 1 } })],
  ['created negative', row('ses_a', { time: { created: -1, updated: 1 } })],
  ['created over max', row('ses_a', { time: { created: 9e18, updated: 1 } })],
  ['created huge int', '{"id":"ses_a","location":{"directory":"/x"},'
    + '"time":{"created":12345678901234567890123456789012345678901234567890,'
    + '"updated":1}}'],
  ['created inf token', '{"id":"ses_a","location":{"directory":"/x"},'
    + '"time":{"created":1e999,"updated":1}}'],
  ['viewed bad type', row('ses_a', { time: { created: 1, updated: 1, viewed: 'x' } })],
]
it.each(bad)('refuses malformed row: %s', async (_name, item) => {
  const r = await parse(item)
  expect(r.code).toBe(1)
  expect(r.out).toEqual({ error: 'reply_invalid' })
})

it('bounds and validates the argv request itself', async () => {
  // Empty, unparseable and oversized argv bodies are argv-level refusals;
  // values that parse but are not rows stay row-level, covered above.
  for (const raw of ['', 'not json at all',
    JSON.stringify(row('ses_a', { title: 't'.repeat(4000) }))]) {
    const r = await parse(raw)
    expect(r.code, raw.slice(0, 24)).toBe(1)
    expect(r.out, raw.slice(0, 24)).toEqual({ error: 'invalid_request' })
  }
})
