import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { OPENCODE_DISCOVER, opencodeDiscover } from '../server/utils/opencodeTransport'
import { localShell } from '../server/utils/agentProcesses'
import type { ExecResult, ShellExec } from '../server/utils/fsx'

// The helper runs for real (owned python3, owned HOME, an owned loopback HTTP
// fixture), never against an installed OpenCode: every fixture home gets an
// owned default `~/.opencode/bin/opencode` stub — the first discovery
// candidate — so a missing/default-state case can only ever reach that owned
// file; the hard-coded global CLI candidates behind it are never probed.
const run = promisify(execFile)
const homes: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  for (const s of servers.splice(0)) await new Promise<void>(resolve => s.close(() => resolve()))
})

interface Peer { url: string, hits: http.IncomingMessage[], close: () => Promise<void> }
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (req, res) => {
  if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
  res.statusCode = 404; res.end()
}): Promise<Peer> {
  const hits: http.IncomingMessage[] = []
  const server = http.createServer((req, res) => { hits.push(req); handler(req, res) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

const basic = (password = 'fixture-password') => 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')

function stateOf(url: string, extra: Record<string, unknown> = {}) {
  return { id: 'fixture', version: '2.0.27', url, pid: 10, password: 'fixture-password', ...extra }
}
function cli(home: string, script = 'exit 42') {
  const bin = path.join(home, '.opencode/bin')
  mkdirSync(bin, { recursive: true })
  const file = path.join(bin, 'opencode')
  writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return file
}
function mkhome(body: Record<string, unknown> | string | null, dir?: string) {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-oc-discover-'))
  homes.push(home)
  cli(home)
  if (body !== null) {
    const d = dir || path.join(home, '.local/state/opencode')
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'service.json'), typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 })
  }
  return home
}
async function discover(home: string, env: NodeJS.ProcessEnv = {}) {
  const merged = { ...process.env, HOME: home, XDG_STATE_HOME: '', ...env }
  try {
    const r = await run('python3', ['-X', 'utf8', '-c', OPENCODE_DISCOVER, home], { env: merged, timeout: 15000 })
    return { out: JSON.parse(r.stdout.trim()), raw: r.stdout + r.stderr }
  } catch (error) {
    const e = error as { stdout: string, stderr: string }
    return { out: JSON.parse(e.stdout.trim()), raw: e.stdout + e.stderr }
  }
}

it('discovers, authenticates and reports a stable opaque generation', async () => {
  const peer = await serve()
  const home = mkhome(stateOf(peer.url))
  const { out, raw } = await discover(home)
  expect(out).toEqual({ ok: true, server: expect.stringMatching(/^[a-f0-9]{32}$/), version: '2.0.27' })
  expect(peer.hits.map(h => h.url)).toEqual(['/api/info'])
  expect(peer.hits[0]!.headers.authorization).toBe(basic())
  // Nothing secret-bearing leaves the helper: no password, URL or paths.
  expect(raw).not.toMatch(/fixture-password|127\.0\.0\.1|service\.json/)
  expect(raw).not.toContain(home)
  expect((await discover(home)).out).toEqual(out)
})

it('honors an absolute XDG state dir and ignores a relative one', async () => {
  const peer = await serve()
  const home = mkhome(null)
  const xdg = path.join(home, 'xdg-state')
  mkdirSync(path.join(xdg, 'opencode'), { recursive: true })
  writeFileSync(path.join(xdg, 'opencode/service.json'), JSON.stringify(stateOf(peer.url)))
  expect((await discover(home, { XDG_STATE_HOME: xdg })).out).toMatchObject({ ok: true })
  // A relative XDG_STATE_HOME resolves against the helper's cwd, not the
  // account's: it is ignored and the default state dir is used instead.
  const home2 = mkhome(stateOf(peer.url))
  expect((await discover(home2, { XDG_STATE_HOME: 'relative/state' })).out).toMatchObject({ ok: true })
})

it('reports not_running for missing state and no runnable CLI', async () => {
  const home = mkhome(null)
  expect((await discover(home)).out).toEqual({ error: 'not_running' })
})

it('uses debug paths state only through the owned CLI, bounded and on a deadline', async () => {
  const peer = await serve()
  const home = mkhome(null)
  const custom = path.join(home, 'custom-state')
  mkdirSync(path.join(custom, 'opencode'), { recursive: true })
  writeFileSync(path.join(custom, 'opencode/service.json'), JSON.stringify(stateOf(peer.url)))
  // The fixture CLI sees the fixed argv and a C locale; anything else fails.
  cli(home, `[ "$LC_ALL" = C ] || exit 97
[ "$1 $2 $3" = 'debug paths state' ] || exit 99
printf '%s\\n' '${custom}/opencode'`)
  expect((await discover(home)).out).toMatchObject({ ok: true })
  // A CLI past its deadline, one over the output bound, and one printing a
  // relative path all fail closed as not_running.
  cli(home, 'sleep 30')
  expect((await discover(home)).out).toEqual({ error: 'not_running' })
  cli(home, "printf 'debug paths state ok\\n'; head -c 8192 /dev/zero | tr '\\0' 'x'")
  expect((await discover(home)).out).toEqual({ error: 'not_running' })
  cli(home, "printf 'relative/state\\n'")
  expect((await discover(home)).out).toEqual({ error: 'not_running' })
}, 15000)

it('stops reading the CLI output at its bound and kills the producer before it finishes', async () => {
  const home = mkhome(null)
  // A finite flood: the marker is touched only once every byte was consumed.
  // A capped reader kills the producer long before that — the marker can
  // never exist, no sleeps or thresholds involved.
  writeFileSync(path.join(home, 'flood'), 'x'.repeat(4 * 1024 * 1024))
  cli(home, `cat '${path.join(home, 'flood')}'\ntouch '${path.join(home, 'marker')}'`)
  expect((await discover(home)).out).toEqual({ error: 'not_running' })
  expect(existsSync(path.join(home, 'marker'))).toBe(false)
})

it('cleans the owned CLI group on deadline or success, even with an exited leader', async () => {
  const home = mkhome(null)
  const pids = path.join(home, 'child.pid')
  const pid = () => Number(readFileSync(pids, 'utf8'))
  // The descendant must really be dead, not just unobserved: a zombie can
  // answer kill(pid, 0) briefly, so the check polls until init reaps it.
  const gone = async () => {
    let alive = true
    for (let i = 0; alive && i < 40; i++) {
      try { process.kill(pid(), 0) } catch { alive = false }
      if (alive) await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(alive, `descendant pid ${pid()} must be dead`).toBe(false)
  }
  try {
    // The leader exits at once; its child holds our stdout pipe to the deadline.
    cli(home, `sleep 30 & echo $! > '${pids}'; exit 0`)
    expect((await discover(home)).out).toEqual({ error: 'not_running' })
    await gone()
    // A detached child holding no pipe: discovery still succeeds and still
    // leaves no owned descendant behind.
    const peer = await serve()
    const custom = path.join(home, 'custom-state')
    mkdirSync(path.join(custom, 'opencode'), { recursive: true })
    writeFileSync(path.join(custom, 'opencode/service.json'), JSON.stringify(stateOf(peer.url)))
    cli(home, `sleep 30 >/dev/null 2>&1 & echo $! > '${pids}'
printf '%s\\n' '${custom}/opencode'`)
    expect((await discover(home)).out).toMatchObject({ ok: true })
    await gone()
  } finally {
    // Owned cleanup even when an assertion failed first.
    try { process.kill(pid(), 'SIGKILL') } catch { /* already gone or unwritten */ }
  }
}, 20000)

it('bounds the state read itself: oversized, unreadable and malformed state fail closed', async () => {
  const peer = await serve()
  const home = mkhome(null)
  const file = path.join(home, '.local/state/opencode')
  const write = (body: string) => { mkdirSync(file, { recursive: true }); writeFileSync(path.join(file, 'service.json'), body) }
  // Exactly 64 KiB still parses; one byte past it does not (the bound is on
  // the bytes read, not a stat followed by an unbounded read).
  write(JSON.stringify(stateOf(peer.url)) + ' '.repeat(65536 - JSON.stringify(stateOf(peer.url)).length))
  expect((await discover(home)).out).toMatchObject({ ok: true })
  write(JSON.stringify(stateOf(peer.url)) + ' '.repeat(65537 - JSON.stringify(stateOf(peer.url)).length))
  expect((await discover(home)).out).toEqual({ error: 'state_invalid' })
  for (const body of ['not json', '[1, 2]']) {
    write(body)
    expect((await discover(home)).out).toEqual({ error: 'state_invalid' })
  }
  write(JSON.stringify(stateOf(peer.url)))
  chmodSync(path.join(file, 'service.json'), 0o000)
  expect((await discover(home)).out).toEqual({ error: 'state_invalid' })
  chmodSync(path.join(file, 'service.json'), 0o600)
})

it('refuses unsafe service URLs before any request is made', async () => {
  const peer = await serve()
  const home = mkhome(null)
  // Every unsafe URL is the owned peer's address reshaped — zero hits proves
  // refusal happened before any request could reach it.
  const bad = [peer.url + '/path', peer.url + '/?x=1', peer.url + '#f', peer.url + '/?', peer.url + '/#',
    peer.url.replace('://', '://u:p@'), peer.url.replace('://', '://@'),
    peer.url.replace(/:\d+$/, ':0'), peer.url + ' ', 'http://127.0.0.1:9\n',
    'http://example.invalid', 'https://example.invalid', 'ftp://127.0.0.1:9']
  for (const url of bad) {
    mkhome(stateOf(url), path.join(home, '.local/state/opencode'))
    expect((await discover(home)).out).toEqual({ error: 'url_unsafe' })
    expect(peer.hits).toHaveLength(0)
    rmSync(path.join(home, '.local/state/opencode'), { recursive: true, force: true })
  }
  mkhome(stateOf('x', { url: 42 as unknown }), path.join(home, '.local/state/opencode'))
  expect((await discover(home)).out).toEqual({ error: 'url_unsafe' })
})

it('requires a supported registration, service version and server version', async () => {
  const peer = await serve()
  expect((await discover(mkhome(stateOf(peer.url, { version: '1.9.9' })))).out).toEqual({ error: 'unsupported' })
  expect(peer.hits).toHaveLength(0)
  expect((await discover(mkhome(stateOf(peer.url, { version: 'v2.0.27' })))).out).toMatchObject({ ok: true, version: '2.0.27' })
  // Garbage, oversized and non-string labels are never a version and never
  // reflected: '2.fixture-only-password' must not echo a credential.
  for (const version of ['2.fixture-only-password', 'vv2.0.1', '2.', '2.0.27'.repeat(8), 7, null]) {
    const h = mkhome(stateOf(peer.url, { version: version as unknown }))
    expect((await discover(h)).out).toMatchObject({ error: expect.stringMatching(/unsupported|state_invalid/) })
    const bad = await serve((req, res) => { res.end(JSON.stringify({ version, pid: 10 })) })
    const { out, raw } = await discover(mkhome(stateOf(bad.url)))
    expect(raw).not.toContain('fixture-password')
    expect(out).toEqual({ error: version === 7 || version === null ? 'reply_invalid' : 'unsupported' })
  }
  // A suffix is never reflected: '2.0.27-fixture-only-password' normalizes to
  // the bounded numeric release and emits no marker text.
  const suffixed = await serve((req, res) => { res.end(JSON.stringify({ version: '2.0.27-fixture-only-password', pid: 10 })) })
  const { out: suffixOut, raw: suffixRaw } = await discover(mkhome(stateOf(suffixed.url)))
  expect(suffixOut).toEqual({ ok: true, server: expect.stringMatching(/^[a-f0-9]{32}$/), version: '2.0.27' })
  expect(suffixRaw).not.toContain('fixture-only-password')
  // No generation without the evidence it is minted from.
  for (const missing of [{ id: undefined }, { id: 7 }] as Record<string, unknown>[]) {
    expect((await discover(mkhome(stateOf(peer.url, missing)))).out).toEqual({ error: 'state_invalid' })
  }
  for (const info of [{ version: '2.0.27' }, { version: '2.0.27', pid: 'x' },
    { version: '2.0.27', pid: 0 }, { version: '2.0.27', pid: -3 }]) {
    const bad = await serve((req, res) => { res.end(JSON.stringify(info)) })
    expect((await discover(mkhome(stateOf(bad.url)))).out).toEqual({ error: 'reply_invalid' })
  }
})

it('requires nonempty credentials', async () => {
  const peer = await serve()
  for (const password of ['', null, 7]) {
    const home = mkhome(stateOf(peer.url, { password: password as unknown }))
    expect((await discover(home)).out).toEqual({ error: 'credentials' })
    expect(peer.hits).toHaveLength(0)
    rmSync(home, { recursive: true, force: true })
  }
})

it('keeps authentication failure, unreachability and bad replies distinct', async () => {
  for (const status of [401, 403]) {
    const denied = await serve((req, res) => { res.statusCode = status; res.end() })
    expect((await discover(mkhome(stateOf(denied.url)))).out).toEqual({ error: 'auth' })
  }
  const gone = await serve()
  const down = gone.url
  await gone.close()
  expect((await discover(mkhome(stateOf(down)))).out).toEqual({ error: 'unreachable' })
  for (const body of ['not json', '[1]', '{"version":"2.0.27","pad":"' + 'x'.repeat(70000) + '"}']) {
    const bad = await serve((req, res) => { res.end(body) })
    expect((await discover(mkhome(stateOf(bad.url)))).out).toEqual({ error: 'reply_invalid' })
  }
})

it('never follows a redirect', async () => {
  const target = await serve()
  const bouncer = await serve((req, res) => { res.writeHead(302, { Location: target.url + '/api/info' }); res.end() })
  const home = mkhome(stateOf(bouncer.url))
  expect((await discover(home)).out).toEqual({ error: 'unreachable' })
  expect(bouncer.hits).toHaveLength(1)
  expect(target.hits).toHaveLength(0)
})

it('never uses a proxy, even when the environment asks for one', async () => {
  const proxy = await serve((req, res) => { res.end() })
  const peer = await serve()
  const home = mkhome(stateOf(peer.url))
  const { out } = await discover(home, { http_proxy: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url })
  expect(out).toMatchObject({ ok: true })
  expect(proxy.hits).toHaveLength(0)
  expect(peer.hits).toHaveLength(1)
})

it('times out a service that accepts but never answers', async () => {
  const silent = await serve(() => { /* accept and hold */ })
  const home = mkhome(stateOf(silent.url))
  expect((await discover(home)).out).toEqual({ error: 'unreachable' })
}, 15000)

it('changes generation with registration, server and credential changes', async () => {
  const info = { version: '2.0.27', pid: 10 }
  const peer = await serve((req, res) => { res.end(JSON.stringify(info)) })
  const home = mkhome(stateOf(peer.url))
  const first = (await discover(home)).out.server
  expect(first).toMatch(/^[a-f0-9]{32}$/)
  expect((await discover(home)).out.server).toBe(first)
  info.pid = 11
  expect((await discover(home)).out.server).not.toBe(first)
  info.pid = 10
  const rotated = stateOf(peer.url, { password: 'rotated-fixture-password' })
  writeFileSync(path.join(home, '.local/state/opencode/service.json'), JSON.stringify(rotated))
  expect((await discover(home)).out.server).not.toBe(first)
  writeFileSync(path.join(home, '.local/state/opencode/service.json'), JSON.stringify(stateOf(peer.url, { id: 'other' })))
  expect((await discover(home)).out.server).not.toBe(first)
})

it('opencodeDiscover runs the fixed helper on the owning machine through ShellExec', async () => {
  const peer = await serve()
  const home = mkhome(stateOf(peer.url))
  const r = await opencodeDiscover(localShell, home)
  expect(r).toEqual({ ok: true, server: expect.stringMatching(/^[a-f0-9]{32}$/), version: '2.0.27' })
  expect(peer.hits[0]!.headers.authorization).toBe(basic())
})

it('opencodeDiscover reaches the debug fallback only through the owned default CLI', async () => {
  const peer = await serve()
  const home = mkhome(null)
  // The default fixture stub exits nonzero: discovery fails closed.
  expect(await opencodeDiscover(localShell, home)).toEqual({ ok: false, error: 'not_running' })
  const custom = path.join(home, 'custom-state')
  mkdirSync(path.join(custom, 'opencode'), { recursive: true })
  writeFileSync(path.join(custom, 'opencode/service.json'), JSON.stringify(stateOf(peer.url)))
  cli(home, `[ "$1 $2 $3" = 'debug paths state' ] || exit 99
printf '%s\\n' '${custom}/opencode'`)
  expect(await opencodeDiscover(localShell, home)).toMatchObject({ ok: true })
})

it('opencodeDiscover maps exec and reply failures without exposing diagnostics', async () => {
  const calls: { args: string[], opts: { timeoutMs?: number, maxBytes?: number } | undefined }[] = []
  const fake = (result: ExecResult): ShellExec => async (_script, args = [], opts = {}) => {
    calls.push({ args, opts })
    return result
  }
  const hex = 'a'.repeat(32)
  const dead = { code: 127, stdout: Buffer.alloc(0), stderr: 'python3: not found' }
  expect(await opencodeDiscover(fake(dead), '/home/user')).toEqual({ ok: false, error: 'unavailable' })
  const lost = { code: 255, stdout: Buffer.alloc(0), stderr: 'unreachable' }
  expect(await opencodeDiscover(fake(lost), '/home/user')).toEqual({ ok: false, error: 'unreachable' })
  // Not one complete sanitized envelope: noise, extra lines, extra fields,
  // an invalid generation or version, or a reply past the byte bound.
  for (const body of ['not json', '{"error":"auth"}\n{"error":"auth"}', 'x\n{"error":"auth"}',
    `{"ok":true,"server":"${hex}","version":"2.0.27","extra":1}`,
    `{"ok":true,"server":"abc","version":"2.0.27"}`,
    `{"ok":true,"server":"${hex}","version":"v2.0.27"}`,
    `{"ok":true,"server":"${hex}","version":"2.0.27-1"}`,
    `{"ok":true,"server":"${hex}","version":"${'2.0.27'.repeat(8)}"}`,
    `{"ok":true,"server":"${hex}","version":"2.${'1'.repeat(45)}"}`,
    '{"error":"auth","extra":1}', '{"ok":true,"server":"' + hex + '"}',
    `{"error":"auth"}${' '.repeat(8193)}`]) {
    const r = { code: 0, stdout: Buffer.from(body + '\n'), stderr: '' }
    expect(await opencodeDiscover(fake(r), '/home/user'), body.slice(0, 60)).toEqual({ ok: false, error: 'unavailable' })
  }
  const denied = { code: 1, stdout: Buffer.from('{"error":"auth"}\n'), stderr: '' }
  expect(await opencodeDiscover(fake(denied), '/home/user')).toEqual({ ok: false, error: 'auth' })
  const good = { code: 0, stdout: Buffer.from(`{"ok":true,"server":"${hex}","version":"2.0.27"}\n`), stderr: '' }
  expect(await opencodeDiscover(fake(good), '/home/user')).toEqual({ ok: true, server: hex, version: '2.0.27' })
  // A home that is not an absolute bounded path never reaches exec.
  const before = calls.length
  for (const home of ['relative', '/home/user\0x', '/'.padEnd(2000, 'x')]) {
    expect(await opencodeDiscover(fake(good), home)).toEqual({ ok: false, error: 'unavailable' })
  }
  expect(calls).toHaveLength(before)
  // The deadline is finite and capped, however the caller asks.
  await opencodeDiscover(fake(good), '/home/user', { timeoutMs: Infinity })
  await opencodeDiscover(fake(good), '/home/user', { timeoutMs: 999999 })
  await opencodeDiscover(fake(good), '/home/user', { timeoutMs: 1 })
  expect(calls[0]!.args[1]).toBe('/home/user')
  expect(calls[0]!.opts).toMatchObject({ timeoutMs: 15000, maxBytes: expect.any(Number) })
  expect(calls.slice(-3).map(c => c.opts!.timeoutMs)).toEqual([15000, 30000, 1])
})
