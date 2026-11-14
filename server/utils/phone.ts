import fs from 'node:fs'
import { inspect, probe, publishArgs, publishCommand, runTailscale, serveError, tailscaleBins, tailscaledSocket, unpublishArgs } from '../../bin/lib/tailnet.mjs'
import { phoneReach } from '../../shared/phone'
import { qrSvg } from '../../shared/qr'
import type { PhoneError, PhoneResult, PhoneStatus } from '../../shared/phone'
import { APP_URL_FILE, BOOT_APP_URL, DATA_DIR, ENV_APP_URL, TAILNET_REFRESH_MS, log } from './env'
import { setServedHosts } from './hosts'
import { initVapid } from './push'

const PORT = String(process.env.NITRO_PORT || process.env.PORT || 3000)

// The saved address was adopted from `tailscale serve` (applyServed), which
// then also takes it back; one typed by hand stays until it is replaced.
let adopted = (() => {
  try { return JSON.parse(fs.readFileSync(APP_URL_FILE, 'utf8'))?.source === 'serve' } catch { return false }
})()

// APP_URL becomes the phone address: saved in the data folder (read at
// startup, env.ts), used at once for allowed hosts and Web Push.
function saveAppUrl(url: string, fromServe = false) {
  if (process.env.APP_URL === url && (adopted || !fromServe)) return
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(APP_URL_FILE, `${JSON.stringify(fromServe ? { url, source: 'serve' } : { url }, null, 2)}\n`)
  adopted = fromServe
  if (process.env.APP_URL === url) return
  process.env.APP_URL = url
  initVapid()
  log(`APP_URL set to the phone address ${url}`)
}

// The adopted address is gone from `tailscale serve`: forgotten, APP_URL is
// the environment's again.
function forgetAppUrl() {
  fs.rmSync(APP_URL_FILE, { force: true })
  const was = process.env.APP_URL
  if (BOOT_APP_URL) process.env.APP_URL = BOOT_APP_URL
  else delete process.env.APP_URL
  initVapid()
  log(`phone address ${was} is no longer published by tailscale serve: forgotten`)
}

// What `tailscale serve` publishes for wherdr's port becomes what wherdr
// answers on: its hosts are allowed, and APP_URL follows unless the
// environment sets one. An address no longer published is refused again and
// forgotten. `served` null (Tailscale could not be read): nothing changes.
export function applyServed(served: string[] | null | undefined) {
  if (!served) return
  setServedHosts(served)
  if (ENV_APP_URL) return
  const current = process.env.APP_URL || ''
  if (served.length) saveAppUrl(served.includes(current) ? current : served[0]!, true)
  else if (adopted) {
    if (current !== BOOT_APP_URL) forgetAppUrl()
    adopted = false
  }
}

const nameListeners: ((name: string) => void)[] = []
export function onTailnetName(f: (name: string) => void) { nameListeners.push(f) }
function tellName(name: string | null | undefined) {
  if (name) for (const f of nameListeners) f(name)
}

// Reads Tailscale and applies it (applyServed). `maxAgeMs`: skipped when the
// last reading is that recent; concurrent callers share one reading.
let adoptedAt = 0
let adopting: Promise<void> | null = null
export function adoptServed(maxAgeMs = 0): Promise<void> {
  if (adopting) return adopting
  if (maxAgeMs && Date.now() - adoptedAt < maxAgeMs) return Promise.resolve()
  const bins = tailscaleBins()
  adopting = inspect(PORT, bins, bins.length ? null : tailscaledSocket())
    .then((net) => { applyServed(net.served); tellName(net.name) }, (e) => { log(`tailscale serve could not be read: ${e?.message || e}`) })
    .finally(() => { adoptedAt = Date.now(); adopting = null })
  return adopting
}

let watch: ReturnType<typeof setInterval> | null = null
export function startTailnetWatch() {
  void adoptServed()
  watch = setInterval(() => { void adoptServed() }, TAILNET_REFRESH_MS)
}
export function stopTailnetWatch() {
  if (watch) clearInterval(watch)
  watch = null
}

// When the wait for each address started (first check, or publishing):
// transient failures before PHONE_GRACE_MS are shown as 'pending'.
const waitSince = new Map<string, number>()

export async function phoneStatus(): Promise<PhoneStatus> {
  const bins = tailscaleBins()
  const socket = bins.length ? null : tailscaledSocket()
  const out: PhoneStatus = {
    mode: bins.length ? 'native' : 'missing',
    platform: process.platform, port: PORT, connected: false, https: false, url: null, served: false, funnel: false, taken: false, suggested: null,
    command: publishCommand(PORT), reach: null, reachCause: null, reachStatus: null, checkedAt: null, appUrl: '', appUrlFromEnv: Boolean(ENV_APP_URL), qr: null,
  }
  if (bins.length || socket) {
    const net = await inspect(PORT, bins, socket)
    applyServed(net.served)
    tellName(net.name)
    out.connected = Boolean(net.connected && net.name)
    out.https = Boolean(net.https)
    out.served = Boolean(net.phone?.served)
    out.funnel = Boolean(net.phone?.funnel)
    out.taken = Boolean(net.taken)
    out.suggested = net.phone?.url ?? null
    out.url = out.served ? net.phone!.url : null
  }
  if (out.url) {
    const p = await probe(out.url, 5000)
    const since = waitSince.get(out.url) ?? Date.now()
    if (p.reach === 'ok') waitSince.delete(out.url)
    else waitSince.set(out.url, since)
    out.reach = phoneReach(p, since)
    out.reachCause = p.cause ?? null
    out.reachStatus = p.status ?? null
    out.checkedAt = Date.now()
  }
  out.appUrl = process.env.APP_URL || ''
  if (out.reach === 'ok' && out.url) out.qr = qrSvg(out.url)
  return out
}

const fail = async (error: PhoneError, more: { link?: string, detail?: string } = {}): Promise<PhoneResult> =>
  ({ ok: false, error, ...more, status: await phoneStatus() })

export async function phoneAction(body: { action?: unknown, url?: unknown }): Promise<PhoneResult> {
  if (body.action !== 'publish' && body.action !== 'unpublish') return fail('failed', { detail: 'Unknown action' })
  const bins = tailscaleBins()
  if (!bins.length) return fail('offline', { link: 'https://tailscale.com/download' })
  // The CLI that answered (on macOS the app's binary may not, issue #724).
  const net = await inspect(PORT, bins)
  if (!net.connected || !net.phone) return fail('offline', { link: 'https://tailscale.com/download' })
  let args: string[]
  if (body.action === 'publish') {
    if (net.phone.served) return { ok: true, status: await phoneStatus() }
    if (net.taken) return fail('taken')
    args = publishArgs(PORT)
  } else {
    if (!net.phone.served) return { ok: true, status: await phoneStatus() }
    args = unpublishArgs(net.phone.httpsPort)
  }
  const r = await runTailscale(net.bin || bins[0]!, args)
  // A fresh publication: its certificate wait starts now.
  waitSince.clear()
  log(`tailscale ${args.join(' ')} → ${r.code}`)
  if (r.code !== 0) {
    const known = serveError(r.output)
    return fail(known?.code ?? 'failed', { link: known?.link, detail: r.output.trim().slice(-600) })
  }
  return { ok: true, status: await phoneStatus() }
}
