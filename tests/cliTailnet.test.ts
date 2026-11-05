// The tailnet helpers shared by `wherdr phone` and the server: the phone
// address, Tailscale's errors, and whether the published address answers.
import { describe, expect, it } from 'vitest'
import { healthReach, phoneAddress, serveError, servedAddresses, servedPorts, tailnetStatus, tailscaleBin } from '../bin/lib/tailnet.mjs'

const URL = 'https://box.example.ts.net:7683/'

describe('phone address', () => {
  const serve = (web: Record<string, string>) => JSON.stringify({ Web: Object.fromEntries(Object.entries(web).map(([k, proxy]) => [k, { Handlers: { '/': { Proxy: proxy } } }])) })

  it('is the tailscale serve entry that proxies to the local port, on whatever HTTPS port', () => {
    expect(phoneAddress('box.example.ts.net', '7683', serve({ 'box.example.ts.net:7683': 'http://127.0.0.1:7683' }))).toEqual({ url: URL, served: true, httpsPort: '7683' })
    expect(phoneAddress('box.example.ts.net', '7683', serve({ 'box.example.ts.net:8101': 'http://127.0.0.1:8101', 'box.example.ts.net:8103': 'http://localhost:7683' }))).toEqual({ url: 'https://box.example.ts.net:8103/', served: true, httpsPort: '8103' })
    expect(phoneAddress('box.example.ts.net', '7683', serve({ 'box.example.ts.net:443': 'http://127.0.0.1:7683' }))?.url).toBe('https://box.example.ts.net/')
  })

  it('is not published when no entry proxies to the local port', () => {
    expect(phoneAddress('box.example.ts.net', '7683', serve({ 'box.example.ts.net:7683': 'http://127.0.0.1:76830' }))?.served).toBe(false)
    expect(phoneAddress('box.example.ts.net', '7683', 'not json')?.served).toBe(false)
    expect(phoneAddress(null, '7683', '')).toBeNull()
  })

  it('lists the HTTPS ports already served, so publishing never replaces another service', () => {
    expect(servedPorts(serve({ 'box.example.ts.net:8101': 'http://127.0.0.1:8101', 'box.example.ts.net:443': 'http://127.0.0.1:3000' }))).toEqual(['8101', '443'])
    expect(servedPorts('{}')).toEqual([])
  })

  it('reads whether Tailscale is connected and issues HTTPS certificates', () => {
    expect(tailnetStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.example.ts.net.' }, CertDomains: ['box.example.ts.net'] })))
      .toEqual({ name: 'box.example.ts.net', connected: true, https: true })
    expect(tailnetStatus(JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'box.example.ts.net.' }, CertDomains: null })))
      .toEqual({ name: 'box.example.ts.net', connected: false, https: false })
    expect(tailnetStatus('not json')).toEqual({ name: null, connected: false, https: false })
  })

  it('finds the macOS app binary of Tailscale', () => {
    const mac = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    expect(tailscaleBin({ PATH: '/usr/bin' }, (p: string) => p === mac)).toBe(mac)
    expect(tailscaleBin({ PATH: '/opt/x/bin' }, (p: string) => p === '/opt/x/bin/tailscale')).toBe('/opt/x/bin/tailscale')
    expect(tailscaleBin({ PATH: '' }, () => false)).toBeNull()
  })
})

describe('tailscale serve errors', () => {
  it('names the known causes, with a link', () => {
    expect(serveError('Access denied: serve config denied\nUse \'sudo tailscale set --operator=$USER\'')?.code).toBe('operator')
    expect(serveError('Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n'))
      .toEqual({ code: 'https', link: 'https://login.tailscale.com/f/serve?node=abc123' })
    expect(serveError('Tailscale is stopped.')?.code).toBe('offline')
    expect(serveError('failed to connect to local tailscaled; it doesn\'t appear to be running')?.code).toBe('offline')
    expect(serveError('something new')).toBeNull()
  })
})

// What wherdr adopts by itself: only what `tailscale serve` publishes for its
// own port, on this machine's own name.
describe('addresses published for wherdr', () => {
  const NAME = 'host.example.ts.net'
  const web = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).map(([k, proxy]) => [k, { Handlers: { '/': { Proxy: proxy } } }]))
  const config = (o: object) => JSON.stringify(o)

  it('lists the HTTPS addresses of this machine that proxy to wherdr’s port', () => {
    const serve = config({ TCP: { 7683: { HTTPS: true } }, Web: web({ [`${NAME}:7683`]: 'http://127.0.0.1:7683', [`${NAME}:443`]: 'http://localhost:7683', [`${NAME}:8101`]: 'http://127.0.0.1:8101' }) })
    expect(servedAddresses(NAME, '7683', serve)).toEqual([`https://${NAME}:7683/`, `https://${NAME}/`])
  })

  it('counts a `tailscale serve` still running in a terminal', () => {
    const serve = config({ Foreground: { abc: { Web: web({ [`${NAME}:7683`]: 'http://127.0.0.1:7683' }) } } })
    expect(servedAddresses(NAME, '7683', serve)).toEqual([`https://${NAME}:7683/`])
    expect(phoneAddress(NAME, '7683', serve)).toMatchObject({ served: true, httpsPort: '7683' })
  })

  it('ignores another port, another name, and an address opened to the Internet', () => {
    expect(servedAddresses(NAME, '7683', config({ Web: web({ [`${NAME}:7683`]: 'http://127.0.0.1:3000' }) }))).toEqual([])
    expect(servedAddresses(NAME, '7683', config({ Web: web({ 'other.example.ts.net:7683': 'http://127.0.0.1:7683' }) }))).toEqual([])
    const funnel = config({ Web: web({ [`${NAME}:443`]: 'http://127.0.0.1:7683' }), AllowFunnel: { [`${NAME}:443`]: true } })
    expect(servedAddresses(NAME, '7683', funnel)).toEqual([])
    expect(phoneAddress(NAME, '7683', funnel)).toEqual({ url: `https://${NAME}/`, served: true, httpsPort: '443', funnel: true })
  })

  it('tells nothing published ([]) from a configuration it could not read (null)', () => {
    expect(servedAddresses(NAME, '7683', '{}')).toEqual([])
    for (const unread of ['', 'not json', 'null', '[]']) expect(servedAddresses(NAME, '7683', unread)).toBeNull()
    expect(servedAddresses(null, '7683', '{}')).toBeNull()
  })
})

// The probes ask /api/health, which goes through wherdr's host check (the
// static manifest answers for any host name).
describe('phone address probe', () => {
  it('tells an address wherdr accepts from one it refuses', () => {
    expect(healthReach(200, '{"ok":true,"name":"wherdr","version":"1.4.0"}')).toBe('ok')
    expect(healthReach(403, '{"error":"Host not allowed","code":"host"}')).toBe('host')
  })
  it('leaves an older wherdr or another program to the manifest check', () => {
    expect(healthReach(404, '{"error":"Not found"}')).toBeNull()
    expect(healthReach(401, '{"code":"locked"}')).toBeNull()
    expect(healthReach(200, '<html>something else</html>')).toBeNull()
    expect(healthReach(403, 'Forbidden')).toBeNull()
  })
})
