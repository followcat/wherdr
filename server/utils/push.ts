// Web Push (iOS 16.4+, installed PWA): the notification is delivered by Apple, so it
// arrives even if Tailscale is off on the phone, and a tap reopens the PWA
// itself (an ntfy notification would open Safari).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'
import { DATA_DIR, appUrl, log } from './env'
import { pushConfig } from './pushConfig'
import type { Pane } from '../../shared/types'
import { type Quiet, quietActive, silenced } from '../../shared/quiet'
import { type PushDelivery, type PushDeviceView, classifyPushError, expiredLongAgo, pushProvider } from '../../shared/pushDelivery'

const fsp = fs.promises
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json')
const SUBS_FILE = path.join(DATA_DIR, 'push.json')
const QUIET_FILE = path.join(DATA_DIR, 'quiet.json')

export interface PushSub {
  endpoint: string
  keys: { p256dh: string, auth: string }
  lang: 'en' | 'fr'
  addedAt: string
  sessions?: Record<string, string>
  quiet?: Quiet // mode silence de cet appareil
  last?: PushDelivery // result of the last send to this device
}
// Text in English, with the French version for devices subscribed in French
// (the language is stored with the subscription; English by default).
export interface PushPayload {
  title: string
  titleFr?: string
  body: string
  bodyFr?: string
  tag: string
  url: string
  badge?: number
}

let vapid: { publicKey: string, privateKey: string } | null = null

export function initVapid() {
  vapid = null
  const config = pushConfig(appUrl())
  if (!config.enabled) {
    log(`WARNING: APP_URL is not a valid HTTPS URL; Web Push is disabled (fallback VAPID subject: ${config.subject}). Set a private HTTPS URL for notifications.`)
    return
  }
  try {
    vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'))
  } catch {
    vapid = webpush.generateVAPIDKeys()
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2) + '\n', { mode: 0o600 })
    log('VAPID keys generated')
  }
  try {
    webpush.setVapidDetails(config.subject, vapid!.publicKey, vapid!.privateKey)
  } catch (error) {
    vapid = null
    log(`WARNING: VAPID subject rejected; Web Push is disabled (${String(error)}).`)
  }
}
export const pushReady = () => Boolean(vapid)
export const vapidPublicKey = () => (vapid ? vapid.publicKey : null)

export async function readSubs(): Promise<PushSub[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(SUBS_FILE, 'utf8'))
    return Array.isArray(raw.subs) ? raw.subs : []
  } catch { return [] }
}
export async function writeSubs(subs: PushSub[]) {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await fsp.writeFile(SUBS_FILE, JSON.stringify({ subs }, null, 2) + '\n', { mode: 0o600 })
}

// `audience`: the devices a notification goes to (none given: all of them).
export type PushAudience = (sub: PushSub) => boolean

export function subWatchesSession(sub: PushSub, baseKey: string, session: string, baseSession: string): boolean {
  return (sub.sessions?.[baseKey] || baseSession) === session
}

// Quiet mode for all devices (DATA_DIR/quiet.json, kept across restarts).
export async function readGlobalQuiet(): Promise<Quiet | null> {
  try {
    const q = JSON.parse(await fsp.readFile(QUIET_FILE, 'utf8')).quiet
    return q && (q.until === null || typeof q.until === 'number') && quietActive(q) ? { until: q.until } : null
  } catch { return null }
}
export async function writeGlobalQuiet(quiet: Quiet | null) {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await fsp.writeFile(QUIET_FILE, JSON.stringify({ quiet }, null, 2) + '\n', { mode: 0o600 })
}

// `force`: the test notification goes through despite quiet mode (explicit gesture).
// Title of an agent notification ("laptop · Claude needs your input"), in both languages.
export function agentNotificationTitle(kind: 'blocked' | 'done', who: string): { title: string, titleFr: string } {
  return kind === 'blocked'
    ? { title: `${who} needs your input`, titleFr: `${who} attend ta réponse` }
    : { title: `${who} has finished`, titleFr: `${who} a terminé` }
}

export async function pushSend(payload: PushPayload, audience?: PushAudience, force = false): Promise<number> {
  if (!pushReady()) return 0
  const subs = await readSubs()
  const globalQuiet = force ? null : await readGlobalQuiet()
  const results = new Map<string, PushDelivery>()
  let ok = 0
  for (const sub of subs) {
    // An expired subscription can never deliver again: it stays listed until removed.
    if (sub.last?.status === 'expired') continue
    // Filter before sending: nothing goes to a muted device.
    if (!force && silenced(globalQuiet, sub.quiet)) continue
    if (audience && !audience(sub)) continue
    try {
      const { titleFr, bodyFr, ...message } = payload
      if (sub.lang === 'fr') {
        message.title = titleFr || message.title
        message.body = bodyFr || message.body
      }
      await webpush.sendNotification(sub, JSON.stringify(message), { TTL: 3600, urgency: 'high' })
      results.set(sub.endpoint, { at: new Date().toISOString(), status: 'ok' })
      ok++
    } catch (e) {
      const result = classifyPushError(e)
      results.set(sub.endpoint, { at: new Date().toISOString(), ...result })
      log(`push: delivery failed (${result.status}${result.code ? ` ${result.code}` : ''}) to device ${pushDeviceId(sub.endpoint)}`)
    }
  }
  // Re-read before writing: sending took time, and a subscription or
  // quiet setting saved in the meantime must not be overwritten by the old list.
  if (results.size) await writeSubs(recordDeliveries(await readSubs(), results))
  return ok
}

// Each device keeps its own result; long-expired ones are dropped.
export function recordDeliveries(subs: PushSub[], results: Map<string, PushDelivery>, now = Date.now()): PushSub[] {
  return subs.map((s) => {
    const last = results.get(s.endpoint)
    return last ? { ...s, last } : s
  }).filter(s => !expiredLongAgo(s.last, now))
}

// Opaque, stable id of a subscription: the endpoint is a capability URL and stays here.
export const pushDeviceId = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex').slice(0, 16)

export function pushDeviceViews(subs: PushSub[], currentEndpoint = ''): PushDeviceView[] {
  return subs.map(s => ({ id: pushDeviceId(s.endpoint), provider: pushProvider(s.endpoint), lang: s.lang === 'fr' ? 'fr' : 'en',
    addedAt: s.addedAt, last: s.last || null, current: Boolean(currentEndpoint) && s.endpoint === currentEndpoint }))
}
