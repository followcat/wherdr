import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAuth } from '../server/utils/auth'
import { allowedHosts, crossSiteRequest, tailnetDomainHosts, hostAllowed, hostRefusalIsHtml, hostRefusedPage, networkRefusedPage, phoneFixCommand, tailnetName } from '../server/utils/hosts'
import { cspForHtml, tailnetImageSources } from '../server/utils/csp'

const req = (cookie = '') => ({ headers: { origin: 'http://localhost:7683', cookie } })
const auth = (log = () => {}) => createAuth({ dataDir: mkdtempSync(path.join(tmpdir(), 'hw-release-')), log })

describe('allowed hosts', () => {
  const names = allowedHosts('https://phone.example.ts.net:7683/', 'server.lan,192.0.2.9', {
    eth0: [{ address: '10.0.0.4', family: 'IPv4', internal: false, netmask: '', cidr: null, mac: '', scopeid: 0 }],
  })
  it('accepts local names, APP_URL, interfaces and the configuration', () => {
    for (const host of ['localhost:7683', '127.0.0.1:7683', '[::1]:7683', 'phone.example.ts.net:7683', 'server.lan', '10.0.0.4', '192.0.2.9']) {
      expect(hostAllowed(host, names)).toBe(true)
    }
  })
  it('refuses a DNS rebinding origin or a malformed Host', () => {
    for (const host of ['evil.example:7683', 'evil.example@localhost', 'localhost/path', '', 'localhost:bad']) {
      expect(hostAllowed(host, names)).toBe(false)
    }
  })
  it('answers a refused browser page with HTML, the API and other clients with JSON', () => {
    const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    expect(hostRefusalIsHtml('/', browser)).toBe(true)
    expect(hostRefusalIsHtml('/s/abc', [browser])).toBe(true)
    expect(hostRefusalIsHtml('/api/state', browser)).toBe(false)
    expect(hostRefusalIsHtml('/manifest.webmanifest', 'application/json')).toBe(false)
    expect(hostRefusalIsHtml('/', undefined)).toBe(false)
    expect(hostRefusalIsHtml('/', '*/*')).toBe(false)
  })
  it('keeps the refusal page free of the instance’s hosts and addresses, and of scripts', () => {
    for (const [install, host] of [['brew', 'nas.example.ts.net'], ['npm', 'nas.lan:7690'], ['native', '<script>alert(1)</script>'], ['plugin', undefined], ['', '192.0.2.7']] as const) {
      const page = hostRefusedPage(install, host, '7690')
      expect(page).not.toMatch(/nas\.|192\.0|alert/)
      expect(page).toContain('This address isn\'t enabled yet.')
      expect(page).not.toContain('lang="fr"')
      expect(page.match(/<h1/g)).toHaveLength(1)
      // The only address in it is the public installer's.
      expect(page.replaceAll('https://wherdr.dev/install', '')).not.toMatch(/<script|<form|ts\.net|https?:\/\/|APP_URL|localhost/i)
    }
  })
  it('explains network refusals in English only', () => {
    for (const why of [undefined, 'funnel'] as const) {
      const page = networkRefusedPage(why)
      expect(page).toContain('<html lang="en">')
      expect(page).not.toContain('lang="fr"')
      expect(page.match(/<h1/g)).toHaveLength(1)
      expect(page).toContain(why ? 'Tailscale Funnel opens' : 'wherdr only answers')
    }
  })
  it('gives a command that works on a machine without a screen, for each kind of install', () => {
    expect(phoneFixCommand('brew', '')).toBe('wherdr phone')
    expect(phoneFixCommand('npm-global', '7683')).toBe('wherdr phone')
    expect(phoneFixCommand('npm', '')).toBe('npx wherdr phone')
    expect(phoneFixCommand('', '7683')).toBe('npx wherdr phone')
    // No `wherdr` command on the host there: the installer ends with the same check.
    expect(phoneFixCommand('plugin', '7690')).toBe('curl -fsSL https://wherdr.dev/install | sh')
    expect(hostRefusedPage('plugin')).toContain('<pre><code>curl -fsSL https://wherdr.dev/install | sh</code></pre>')
  })
  it('names the port in the command when wherdr does not run on the default one', () => {
    // `wherdr phone` alone looks at port 7683.
    expect(phoneFixCommand('', '7690')).toBe('npx wherdr phone --port 7690')
    expect(phoneFixCommand('npm-global', '8080')).toBe('wherdr phone --port 8080')
    expect(phoneFixCommand('brew', 'abc; rm -rf')).toBe('wherdr phone')
    expect(hostRefusedPage('', 'box.example.ts.net', '7690')).toContain('<pre><code>npx wherdr phone --port 7690</code></pre>')
  })
  it('explains HERDR_WEB_ALLOWED_HOSTS for a name tailscale serve cannot have published', () => {
    expect(tailnetName('box.example.ts.net:443')).toBe(true)
    expect(tailnetName('BOX.Example.TS.net.')).toBe(true)
    for (const host of ['box.lan:7690', '192.0.2.7', 'ts.net.example.org', '', undefined]) expect(tailnetName(host)).toBe(false)
    const tailnet = hostRefusedPage('npm', 'box.example.ts.net')
    expect(tailnet).not.toContain('HERDR_WEB_ALLOWED_HOSTS')
    const lan = hostRefusedPage('npm', 'box.lan:7690')
    expect(lan.match(/HERDR_WEB_ALLOWED_HOSTS/g)).toHaveLength(1)
    expect(lan).toContain('~/wherdr/wherdr.env')
    expect(lan).toContain('npx wherdr phone')
  })
  it('allows the hosts read from tailscale serve, next to the others', () => {
    const served = allowedHosts('', '', {}, ['host.example.ts.net'])
    expect(hostAllowed('host.example.ts.net:7683', served)).toBe(true)
    expect(hostAllowed('other.example.ts.net:7683', served)).toBe(false)
  })
})

describe('first key and challenges', () => {
  it('logs a token at startup and checks it before the challenge', async () => {
    const lines: string[] = []
    const a = auth((...parts) => lines.push(parts.join(' ')))
    const token = a._bootstrapToken()
    expect(lines.join(' ')).toContain(token)
    await expect(a.registerOptions(req(), {})).rejects.toMatchObject({ code: 'bootstrap' })
    await expect(a.registerOptions(req(), { bootstrapToken: 'incorrect' })).rejects.toMatchObject({ code: 'bootstrap' })
    const options = await a.registerOptions(req(), { bootstrapToken: token })
    expect(options.challenge).toBeTruthy()
    expect(options.__cookie).toMatch(/^hw_challenge=/)
  })

  it('binds each challenge to a client cookie and does not let another client overwrite it', async () => {
    const a = auth()
    const first = await a.loginOptions(req())
    const second = await a.loginOptions(req())
    const cookie1 = first.__cookie.split(';')[0]!
    const cookie2 = second.__cookie.split(';')[0]!
    expect(a._takeChallenge(req(cookie1), 'auth')).toBe(first.challenge)
    expect(a._takeChallenge(req(cookie2), 'auth')).toBe(second.challenge)
    expect(() => a._takeChallenge(req(cookie1), 'auth')).toThrow()
    expect(() => a._takeChallenge(req(), 'auth')).toThrow()
  })
})

it('only allows the exact inline scripts of the Nuxt HTML', () => {
  const policy = cspForHtml('<html><script type="importmap">{"imports":{}}</script><script>window.__NUXT__={}</script><script type="application/json">{}</script></html>', 'localhost:7690')
  expect(policy).toContain("script-src 'self' 'sha256-")
  expect(policy.match(/'sha256-/g)).toHaveLength(2)
  expect(policy.match(/script-src ([^;]+)/)?.[1]).not.toContain('unsafe-inline')
  expect(policy).toContain("frame-ancestors 'none'")
  expect(policy).toContain("connect-src 'self' ws://localhost:7690 wss://localhost:7690")
})

describe('images allowed in replies', () => {
  it('allows every machine and port of the tailnets wherdr is reached on, over HTTPS only', () => {
    expect(tailnetImageSources(['box.example.ts.net', 'DESK.Example.TS.net.', 'laptop.example.ts.net'])).toEqual(['https://*.example.ts.net:*'])
    expect(tailnetImageSources(['box.example.ts.net', 'nas.home-lab.ts.net'])).toEqual(['https://*.example.ts.net:*', 'https://*.home-lab.ts.net:*'])
  })
  it('adds nothing for a name outside a tailnet, nor anything that could widen the policy', () => {
    for (const name of ['localhost', '127.0.0.1', '::1', 'box.lan', 'example.ts.net', 'ts.net', 'a.b.example.ts.net', 'box.example.ts.net.evil.com', 'box.exa*mple.ts.net', 'box.example.ts.net; img-src *', '-box.example.ts.net', '']) {
      expect(tailnetImageSources([name]), name).toEqual([])
    }
  })
  it('reads the tailnet from the allowed hosts and from Tailscale\'s name for this machine', () => {
    expect(tailnetDomainHosts(new Set(['localhost', 'box.example.ts.net']), '')).toEqual(['localhost', 'box.example.ts.net'])
    expect(tailnetImageSources(tailnetDomainHosts(new Set(['localhost']), 'studio.example.ts.net'))).toEqual(['https://*.example.ts.net:*'])
  })
  it('only widens img-src: every other directive stays as it was', () => {
    const html = '<html><script>window.__NUXT__={}</script></html>'
    const plain = cspForHtml(html, 'box.example.ts.net')
    const wide = cspForHtml(html, 'box.example.ts.net', ['https://*.example.ts.net:*'])
    expect(plain).toContain("img-src 'self' data: blob:;")
    expect(wide).toContain("img-src 'self' data: blob: https://*.example.ts.net:*;")
    const without = (policy: string) => policy.split('; ').filter(d => !d.startsWith('img-src '))
    expect(without(wide)).toEqual(without(plain))
  })
})

describe('crossSiteRequest', () => {
  it('refuses an API request made from another site, even localhost on another port', () => {
    expect(crossSiteRequest({ 'sec-fetch-site': 'cross-site' })).toBe(true)
    expect(crossSiteRequest({ 'sec-fetch-site': 'same-site' })).toBe(true)
  })
  it('accepts the app itself, a typed address and clients without the header', () => {
    expect(crossSiteRequest({ 'sec-fetch-site': 'same-origin' })).toBe(false)
    expect(crossSiteRequest({ 'sec-fetch-site': 'none' })).toBe(false)
    expect(crossSiteRequest({})).toBe(false)
  })
})
