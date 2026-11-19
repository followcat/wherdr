// Web Push (iOS 16.4+, installed PWA): the notification is delivered by Apple, so it
// arrives even if Tailscale is off on the phone, and a tap reopens the PWA
// itself (an ntfy notification would open Safari).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'
import { DATA_DIR, appUrl, log } from './env'
import { auth } from './http'
import { readJsonOrMissing, writeJsonAtomic, writeJsonAtomicSync } from './atomicWrite'
import { pushConfig } from './pushConfig'
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
  // Lock generation when the device subscribed (auth.generation()): Lock all
  // devices changes it, and this subscription is then dropped. Missing on
  // subscriptions saved before: kept until the next Lock all devices.
  gen?: string
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
  const keys = readVapid()
  if (keys === 'unreadable') return
  if (keys) vapid = keys
  else {
    vapid = webpush.generateVAPIDKeys()
    writeJsonAtomicSync(VAPID_FILE, vapid)
    log('VAPID keys generated')
  }
  try {
    webpush.setVapidDetails(config.subject, vapid!.publicKey, vapid!.privateKey)
  } catch (error) {
    vapid = null
    log(`WARNING: VAPID subject rejected; Web Push is disabled (${String(error)}).`)
  }
}
// The saved keys; null: none saved yet. A file that cannot be read (its
// rights) or holds no keys is never replaced in silence: new keys would drop
// every subscribed device. Unreadable: push stays off, logged. Damaged: kept
// beside as vapid.json.damaged-<time>, logged, and new keys are made.
function readVapid(file = VAPID_FILE): { publicKey: string, privateKey: string } | null | 'unreadable' {
  let text: string
  try { text = fs.readFileSync(file, 'utf8') }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    log(`WARNING: the VAPID keys file cannot be read; Web Push is disabled, the file is kept (${String(e)}).`)
    return 'unreadable'
  }
  try {
    const k = JSON.parse(text)
    if (typeof k?.publicKey === 'string' && typeof k?.privateKey === 'string') return { publicKey: k.publicKey, privateKey: k.privateKey }
  } catch { /* damaged below */ }
  const aside = `${file}.damaged-${Date.now()}`
  try { fs.renameSync(file, aside) }
  catch (e) {
    log(`WARNING: the VAPID keys file is damaged and could not be set aside; Web Push is disabled (${String(e)}).`)
    return 'unreadable'
  }
  log(`WARNING: the VAPID keys file was damaged; kept as ${path.basename(aside)}, new keys are made (devices subscribe again).`)
  return null
}
export const pushReady = () => Boolean(vapid)
export const vapidPublicKey = () => (vapid ? vapid.publicKey : null)

// Strict: only a missing file is empty; anything else throws, so a list
// written back never drops every device.
async function loadSubs(): Promise<PushSub[]> {
  const raw = await readJsonOrMissing(SUBS_FILE) as { subs?: unknown } | undefined
  return Array.isArray(raw?.subs) ? raw.subs : []
}
// For reading and sending only: an unreadable file lists no device.
export const readSubs = () => loadSubs().catch(() => [] as PushSub[])
export async function writeSubs(subs: PushSub[]) {
  await writeJsonAtomic(SUBS_FILE, { subs })
}

// Every change to the list, one after another: devices subscribing at the same
// time (after the lock is turned off) each keep their entry. `change` gets the
// current list and returns the new one, or null to leave the file as it is.
let subsQueue: Promise<unknown> = Promise.resolve()
export function updateSubs(change: (subs: PushSub[]) => PushSub[] | null): Promise<PushSub[]> {
  const run = subsQueue.then(async () => {
    const subs = await loadSubs()
    const next = change(subs)
    if (!next) return subs
    await writeSubs(next)
    return next
  })
  subsQueue = run.catch(() => {})
  return run
}

// `audience`: the devices a notification goes to (none given: all of them).
export type PushAudience = (sub: PushSub) => boolean

// Quiet mode for all devices (DATA_DIR/quiet.json, kept across restarts).
export async function readGlobalQuiet(): Promise<Quiet | null> {
  try {
    const q = JSON.parse(await fsp.readFile(QUIET_FILE, 'utf8')).quiet
    return q && (q.until === null || typeof q.until === 'number') && quietActive(q) ? { until: q.until } : null
  } catch { return null }
}
export async function writeGlobalQuiet(quiet: Quiet | null) {
  await writeJsonAtomic(QUIET_FILE, { quiet })
}

// `force`: the test notification goes through despite quiet mode (explicit gesture).
// Title of an agent notification ("laptop · Claude needs your input"), in both languages.
export function agentNotificationTitle(kind: 'blocked' | 'done', who: string): { title: string, titleFr: string } {
  return kind === 'blocked'
    ? { title: `${who} needs your input`, titleFr: `${who} attend ta réponse` }
    : { title: `${who} has finished`, titleFr: `${who} a terminé` }
}

// A subscription saved under an earlier lock generation (Lock all devices
// since): the device has no session any more and gets nothing.
export const staleSub = (sub: PushSub, generation: string) => sub.gen !== undefined && sub.gen !== generation

// Lock all devices / lock turned off: every subscription goes (none was saved
// under the new generation yet). Returns how many were removed.
export async function dropAllSubs(): Promise<number> {
  let n = 0
  await updateSubs((subs) => { n = subs.length; return n ? [] : null })
  return n
}

export async function pushSend(payload: PushPayload, audience?: PushAudience, force = false): Promise<number> {
  if (!pushReady()) return 0
  const generation = auth.generation()
  const all = await readSubs()
  // Subscribed before a Lock all devices (saved in the meantime by a request
  // already under way): never sent, and removed.
  const subs = all.filter(s => !staleSub(s, generation))
  if (subs.length < all.length) await updateSubs(list => list.filter(s => !staleSub(s, generation)))
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
  if (results.size) await updateSubs(list => recordDeliveries(list, results))
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
