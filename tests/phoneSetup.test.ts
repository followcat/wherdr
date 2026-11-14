// Settings › Phone, server side: who may use it, publishing through a fake
// `tailscale` (its calls recorded), Tailscale errors, the port of another
// service left alone, APP_URL following the address, the wait for the HTTPS
// certificate, and the QR code only once it answers.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Tailnet from '../bin/lib/tailnet.mjs'
import { failureCause } from '../bin/lib/tailnet.mjs'
import { hostAllowed } from '../server/utils/hosts'
import { adoptServed, applyServed, onTailnetName, phoneAction, phoneStatus } from '../server/utils/phone'
import { PHONE_GRACE_MS, phoneReach } from '../shared/phone'
import type { PhoneReachCause } from '../shared/phone'

// Before the server modules load: their data folder and port.
const fake = vi.hoisted(() => {
  const root = `${process.env.TMPDIR || '/tmp'}/wherdr-phone-${process.pid}`
  process.env.DATA_DIR = `${root}/data`
  process.env.PORT = '7699'
  delete process.env.APP_URL
  return { root, bin: `${root}/tailscale`, reach: 'ok' as 'ok' | 'host' | 'other' | 'unreachable', cause: 'refused' as PhoneReachCause }
})

vi.mock('../bin/lib/tailnet.mjs', async orig => ({
  ...await orig<typeof Tailnet>(),
  tailscaleBins: () => [fake.bin],
  probe: async () => fake.reach === 'unreachable' ? { reach: fake.reach, cause: fake.cause } : { reach: fake.reach, status: 200 },
}))

const NAME = 'box.example.ts.net'
const URL = `https://${NAME}:7699/`
const calls = path.join(fake.root, 'calls.log')
const serveFile = path.join(fake.root, 'serve.json')
const failFile = path.join(fake.root, 'fail.txt')

mkdirSync(fake.root, { recursive: true })
// `tailscale status --json` / `serve status --json` from files; `serve …`
// records its arguments, or fails with the text of fail.txt.
writeFileSync(fake.bin, `#!/bin/sh
if [ "$1" = status ]; then echo '{"BackendState":"Running","Self":{"DNSName":"${NAME}."},"CertDomains":["${NAME}"]}'; exit 0; fi
if [ "$1 $2" = "serve status" ]; then cat "${serveFile}"; exit 0; fi
echo "$*" >> "${calls}"
if [ -f "${failFile}" ]; then cat "${failFile}" >&2; exit 1; fi
case "$*" in
  *off) echo '{}' > "${serveFile}" ;;
  *) echo '{"Web":{"${NAME}:7699":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7699"}}}}}' > "${serveFile}" ;;
esac
`)
chmodSync(fake.bin, 0o755)
afterAll(() => rmSync(fake.root, { recursive: true, force: true }))

const appUrlFile = () => path.join(process.env.DATA_DIR!, 'app-url.json')
const callLog = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []

beforeEach(() => {
  writeFileSync(serveFile, '{}')
  rmSync(calls, { force: true })
  rmSync(failFile, { force: true })
  rmSync(appUrlFile(), { force: true })
  delete process.env.APP_URL
  applyServed([])
  fake.reach = 'ok'
  fake.cause = 'refused'
})
afterEach(() => { vi.useRealTimers() })

describe('phone setup', () => {
  it('shows no QR code before wherdr is published', async () => {
    const s = await phoneStatus()
    expect(s).toMatchObject({ mode: 'native', connected: true, served: false, url: null, suggested: URL, qr: null })
    expect(callLog()).toEqual([])
  })

  it('publishes wherdr’s port, then sets APP_URL and draws the QR code once it answers', async () => {
    const r = await phoneAction({ action: 'publish' })
    expect(callLog()).toEqual(['serve --bg --https=7699 http://127.0.0.1:7699'])
    expect(r).toMatchObject({ ok: true, status: { served: true, url: URL, reach: 'ok', appUrl: URL } })
    expect(r.status.qr?.path).toMatch(/^M\d/)
    expect(JSON.parse(readFileSync(appUrlFile(), 'utf8'))).toEqual({ url: URL, source: 'serve' })
    expect(process.env.APP_URL).toBe(URL)
  })

  it('allows its own published address at once, but keeps the QR code back while it does not answer', async () => {
    fake.reach = 'unreachable'
    const r = await phoneAction({ action: 'publish' })
    expect(r.status).toMatchObject({ served: true, reach: 'pending', qr: null, appUrl: URL })
    expect(JSON.parse(readFileSync(appUrlFile(), 'utf8'))).toEqual({ url: URL, source: 'serve' })
  })

  it('waits for the certificate after publishing, then turns to an error once the grace period is over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    fake.reach = 'unreachable'
    fake.cause = 'timeout'
    expect((await phoneAction({ action: 'publish' })).status.reach).toBe('pending')
    vi.setSystemTime(1_000_000 + PHONE_GRACE_MS - 1000)
    expect((await phoneStatus()).reach).toBe('pending')
    vi.setSystemTime(1_000_000 + PHONE_GRACE_MS)
    expect(await phoneStatus()).toMatchObject({ reach: 'unreachable', reachCause: 'timeout', qr: null })
    // Answers at last: green with the QR code.
    fake.reach = 'ok'
    const s = await phoneStatus()
    expect(s.reach).toBe('ok')
    expect(s.qr).not.toBeNull()
    // Published again: a new wait.
    writeFileSync(serveFile, '{}')
    fake.reach = 'unreachable'
    expect((await phoneAction({ action: 'publish' })).status.reach).toBe('pending')
  })

  it('accepts its own address once wherdr refused it only for the host name', async () => {
    writeFileSync(serveFile, `{"Web":{"${NAME}:7699":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7699"}}}}}`)
    fake.reach = 'host'
    const s = await phoneStatus()
    expect(process.env.APP_URL).toBe(URL)
    expect(s.appUrl).toBe(URL)
  })

  it('explains the known Tailscale errors', async () => {
    writeFileSync(failFile, 'Access denied: serve config denied\nUse \'sudo tailscale set --operator=$USER\'\n')
    expect(await phoneAction({ action: 'publish' })).toMatchObject({ ok: false, error: 'operator' })
    writeFileSync(failFile, 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=abc\n')
    expect(await phoneAction({ action: 'publish' })).toMatchObject({ ok: false, error: 'https', link: 'https://login.tailscale.com/f/serve?node=abc' })
    writeFileSync(failFile, 'boom')
    expect(await phoneAction({ action: 'publish' })).toMatchObject({ ok: false, error: 'failed', detail: expect.stringContaining('boom') })
  })

  it('never replaces another service published on the same HTTPS port', async () => {
    writeFileSync(serveFile, `{"Web":{"${NAME}:7699":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}`)
    expect(await phoneAction({ action: 'publish' })).toMatchObject({ ok: false, error: 'taken' })
    expect(callLog()).toEqual([])
  })

  it('unpublishes the HTTPS port wherdr is served on', async () => {
    writeFileSync(serveFile, `{"Web":{"${NAME}:8443":{"Handlers":{"/":{"Proxy":"http://localhost:7699"}}}}}`)
    const r = await phoneAction({ action: 'unpublish' })
    expect(callLog()).toEqual(['serve --https=8443 off'])
    expect(r.status.served).toBe(false)
  })

  it('refuses unknown actions, including the removed manual-address action', async () => {
    expect(await phoneAction({ action: 'rm -rf' })).toMatchObject({ ok: false, error: 'failed' })
    expect(await phoneAction({ action: 'address', url: 'https://example.com/' })).toMatchObject({ ok: false, error: 'failed' })
    expect(callLog()).toEqual([])
  })
})

// No Settings › Phone, no browser on the machine: wherdr reads what
// `tailscale serve` publishes for its port and answers on that address.
describe('automatic adoption of the tailnet address', () => {
  const publish = (hostPort = `${NAME}:7699`, target = 7699) => writeFileSync(serveFile, `{"Web":{"${hostPort}":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:${target}"}}}}}`)

  it('adopts the address published for its own port: allowed host and APP_URL', async () => {
    expect(hostAllowed(`${NAME}:7699`)).toBe(false)
    publish()
    await adoptServed()
    expect(hostAllowed(`${NAME}:7699`)).toBe(true)
    expect(process.env.APP_URL).toBe(URL)
    expect(JSON.parse(readFileSync(appUrlFile(), 'utf8'))).toEqual({ url: URL, source: 'serve' })
  })

  it("tells the machine's Tailscale name at each reading", async () => {
    const names: string[] = []
    onTailnetName((name) => { names.push(name) })
    await adoptServed()
    await phoneStatus()
    expect(names).toEqual([NAME, NAME])
  })

  it('still refuses every other host, another tailnet name included', async () => {
    publish()
    await adoptServed()
    for (const host of ['evil.example:7699', 'other.example.ts.net:7699', `evil.${NAME}:7699`, `${NAME}.evil.example:7699`]) {
      expect(hostAllowed(host)).toBe(false)
    }
  })

  it('adopts nothing published for another port, another machine name, or through funnel', async () => {
    publish(`${NAME}:7699`, 3000)
    await adoptServed()
    expect(hostAllowed(`${NAME}:7699`)).toBe(false)
    publish('other.example.ts.net:7699')
    await adoptServed()
    expect(hostAllowed('other.example.ts.net:7699')).toBe(false)
    writeFileSync(serveFile, `{"Web":{"${NAME}:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7699"}}}},"AllowFunnel":{"${NAME}:443":true}}`)
    fake.reach = 'host'
    expect(await phoneStatus()).toMatchObject({ served: true, funnel: true, reach: 'host', qr: null, appUrl: '' })
    expect(hostAllowed(NAME)).toBe(false)
    expect(existsSync(appUrlFile())).toBe(false)
  })

  it('refuses the address again once it is removed from tailscale serve', async () => {
    publish()
    await adoptServed()
    expect(hostAllowed(`${NAME}:7699`)).toBe(true)
    writeFileSync(serveFile, '{}')
    await adoptServed()
    expect(hostAllowed(`${NAME}:7699`)).toBe(false)
    expect(process.env.APP_URL).toBeUndefined()
    expect(existsSync(appUrlFile())).toBe(false)
  })

  it('keeps what it knows while Tailscale cannot be read', async () => {
    publish()
    await adoptServed()
    writeFileSync(serveFile, '')
    await adoptServed()
    expect(hostAllowed(`${NAME}:7699`)).toBe(true)
    expect(process.env.APP_URL).toBe(URL)
  })

  it('follows the address to another HTTPS port', async () => {
    publish()
    await adoptServed()
    publish(`${NAME}:8443`)
    await adoptServed()
    expect(process.env.APP_URL).toBe(`https://${NAME}:8443/`)
    expect(hostAllowed(`${NAME}:8443`)).toBe(true)
  })

  it('reads Tailscale once for callers that come together, and not again within the given age', async () => {
    publish()
    await Promise.all([adoptServed(), adoptServed(), adoptServed()])
    expect(hostAllowed(`${NAME}:7699`)).toBe(true)
    writeFileSync(serveFile, '{}')
    await adoptServed(60_000)
    expect(hostAllowed(`${NAME}:7699`)).toBe(true)
    await adoptServed()
    expect(hostAllowed(`${NAME}:7699`)).toBe(false)
  })
})

describe('phone address check', () => {
  it('tells why an address does not answer', () => {
    expect(failureCause({ code: 'ENOTFOUND' })).toBe('dns')
    expect(failureCause({ code: 'ECONNREFUSED' })).toBe('refused')
    expect(failureCause(new Error('timeout'))).toBe('timeout')
    expect(failureCause({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe('cert')
    expect(failureCause({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).toBe('cert')
    expect(failureCause({ code: 'EPROTO', message: 'SSL routines:ssl3_get_record:wrong version number' })).toBe('tls')
    expect(failureCause({ code: 'ECONNRESET' })).toBe('network')
  })

  it('records the reason and the time of an unreachable address', async () => {
    fake.reach = 'unreachable'
    fake.cause = 'dns'
    const r = await phoneAction({ action: 'publish' })
    expect(r.status.reach).toBe('unreachable')
    expect(r.status.reachCause).toBe('dns')
    expect(r.status.checkedAt).toBeGreaterThan(0)
  })

  it('only waits on causes that pass while Tailscale gets the certificate', () => {
    const since = 1_000_000
    for (const cause of ['timeout', 'tls', 'refused', 'cert', 'network'] as const) {
      expect(phoneReach({ reach: 'unreachable', cause }, since, since + 5000)).toBe('pending')
      expect(phoneReach({ reach: 'unreachable', cause }, since, since + PHONE_GRACE_MS)).toBe('unreachable')
    }
    expect(phoneReach({ reach: 'unreachable', cause: 'dns' }, since, since)).toBe('unreachable')
    expect(phoneReach({ reach: 'host' }, since, since)).toBe('host')
    expect(phoneReach({ reach: 'other' }, since, since)).toBe('other')
    expect(phoneReach({ reach: 'ok' }, since, since + PHONE_GRACE_MS * 2)).toBe('ok')
  })
})
