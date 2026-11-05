// Agents' waiting screens: what the app
// shows of them. Keys are only sent on a user's button press.
import type { InteractiveMenu, Pane, WaitKind, WaitScreen } from '../../shared/types'
import { language } from './i18n'

// Recognized screen (hooks, trust, login, update): the agent is waiting for
// the user, even if Herdr sees it as "idle". An unknown screen (`other`)
// is only shown while there is no conversation (ChatView).
export function knownScreen(p: Pane | null | undefined): WaitScreen | null {
  return p && p.screen && p.screen.kind !== 'other' && p.status !== 'working' ? p.screen : null
}

const KEYS: Record<string, [string, string]> = {
  enter: ['Entrée', 'Enter'], esc: ['Échap', 'Esc'], tab: ['Tab', 'Tab'], space: ['Espace', 'Space'], left: ['←', '←'], right: ['→', '→'],
}
const pick = (pair: [string, string], en: boolean) => pair[en ? 1 : 0]

export function screenKeyName(key: string, en = language === 'en'): string {
  if (KEYS[key]) return pick(KEYS[key]!, en)
  // "ctrl+a" → "Ctrl+A".
  const m = key.match(/^ctrl\+(\w)$/)
  return m ? `Ctrl+${m[1]!.toUpperCase()}` : key
}

// Summary of an open interactive menu for the home card.
export function menuSummary(m: InteractiveMenu, en = language === 'en'): string {
  return m.title ? `${pick(['Menu', 'Menu'], en)} · ${m.title}` : pick(['Menu ouvert', 'Menu open'], en)
}

// Summary for the home card and a tab's plan.
export function screenSummary(s: WaitScreen, en = language === 'en'): string | null {
  const sums: Partial<Record<WaitKind, [string, string]>> = {
    hooks: ['Hooks à approuver', 'Hooks to review'],
    trust: ['Confiance du dossier demandée', 'Folder trust requested'],
    login: ['Connexion demandée', 'Sign-in required'],
    update: ['Mise à jour proposée', 'Update available'],
  }
  const sum = sums[s.kind]
  return sum ? pick(sum, en) : s.title
}
