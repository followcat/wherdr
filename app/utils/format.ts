// Small display helpers (titles, paths, dates, durations).
import type { HerdrState, Pane } from '#shared/types'
import { cleanTitle, paneTitle as sharedPaneTitle } from '#shared/paneTitle'
export { paneOwnTitle } from '#shared/paneTitle'
import { hasTranscript } from '#shared/agentKind'
export { spaceTitle, conversationSubtitle } from '#shared/displayTitles'

export const KIND_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode', kimi: 'Kimi', qodercli: 'Qoder CLI', mastracode: 'Mastra Code', copilot: 'Copilot', qwen: 'Qwen Code', pi: 'Pi', omp: 'omp' }
export const kindLabel = (k: string | null | undefined) => (k && KIND_LABEL[k]) || (k ? k[0]!.toUpperCase() + k.slice(1) : 'Shell')
export { cleanTitle }
// Home folder -> ~ (Linux /home/<user>, macOS /Users/<user>).
export const shortPath = (p: string | null | undefined) => (p || '').replace(/^\/(?:home|Users)\/[^/]+/, '~') || '~'
// Path displayed right to left (the end is visible): LTR marks around it.
export const ltr = (s: string) => `‎${s}‎`
export const hasChat = (p: Pane | null | undefined) => hasTranscript(p?.agent)

export function paneTitle(p: Pane): string {
  return sharedPaneTitle(p, herdrState.value.workspaces.find(w => w.id === p.workspace)?.label)
}

export function workspaceLabel(state: HerdrState, p: Pane): string {
  const w = state.workspaces.find(x => x.id === p.workspace)
  return w ? w.label : p.workspace
}

const locale = () => (language === 'en' ? 'en-GB' : 'fr-FR')

export function fmtTime(ts: string | number) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
}

// Full date and time (tooltip of a message's time).
export function fmtDateTime(ts: string | number) {
  return new Date(ts).toLocaleString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function dayLabel(ts: string) {
  const d = new Date(ts)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return t('Today')
  if (d.toDateString() === y.toDateString()) return t('Yesterday')
  return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })
}

// Short moment of a message (search results): "il y a 5 min",
// "18:15", "hier 18:15", "lun. 18:15", "26 sept.", "26 sept. 2025".
export function fmtWhen(ts: string, now = Date.now()) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const m = Math.floor((now - d.getTime()) / 60000)
  if (m >= 0 && m < 1) return t('just now')
  if (m >= 0 && m < 60) return tl(`${m} min ago`, `il y a ${m} min`)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(new Date(now)) - day(d)) / 86400000)
  if (days === 0) return fmtTime(ts)
  if (days === 1) return `${t('yesterday')} ${fmtTime(ts)}`
  if (days > 1 && days < 7) return `${d.toLocaleDateString(locale(), { weekday: 'short' })} ${fmtTime(ts)}`
  return d.toLocaleDateString(locale(), {
    day: 'numeric', month: 'short', ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  })
}

export function fmtDuration(s: number) {
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `${h} h ${mm} min` : `${h} h`
}

export const haptic = () => {
  if (navigator.vibrate) navigator.vibrate(8)
}

export const isIOS = import.meta.client && (/iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
// Touch keyboard: Enter adds a line there, a button below the field sends.
export const touchKeyboard = import.meta.client && matchMedia('(pointer: coarse)').matches
export const standalone = import.meta.client && (matchMedia('(display-mode: standalone)').matches
  || (navigator as Navigator & { standalone?: boolean }).standalone === true)

export function b64ToBytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export function bytesToB64(bytes: Uint8Array) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
