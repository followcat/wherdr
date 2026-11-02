// The keys of the phone key bar, each described once (components/PhoneKeybar.vue
// draws them in the order of utils/keybarOrder.ts). `label` is the name read by
// screen readers and shown in Settings; `cap` is the text on the key, `icon`
// replaces it.
import type { VirtualModifier } from './terminalModifiers'
import { PHONE_KEY_IDS, type PhoneKeyId } from './keybarOrder'
import { t, tl } from './i18n'

export interface PhoneKey {
  id: PhoneKeyId
  // The phone keyboard toggle, a sticky modifier, or a key sent to the pane.
  kind: 'keyboard' | 'modifier' | 'key'
  modifier?: VirtualModifier
  send?: string
  label: () => string
  // Shorter name for Settings, when the label is long.
  name?: () => string
  cap?: () => string
  icon?: string
  danger?: boolean
}

const key = (id: PhoneKeyId, label: () => string, extra: Partial<PhoneKey> = {}): PhoneKey =>
  ({ id, kind: 'key', send: id, label, ...extra })
const navIcon = (id: PhoneKeyId, icon: string, label: () => string) => key(id, label, { icon })
const upper = (id: PhoneKeyId) => key(id, () => id.toUpperCase(), { cap: () => id.toUpperCase() })

const KEYS: PhoneKey[] = [
  { id: 'keyboard', kind: 'keyboard', label: () => t('Show or hide the phone keyboard'), name: () => tl('Phone keyboard', 'Clavier du téléphone'), icon: 'i-lucide-keyboard' },
  { id: 'ctrl', kind: 'modifier', modifier: 'ctrl', label: () => t('Ctrl'), cap: () => t('Ctrl') },
  key('esc', () => t('Esc'), { cap: () => t('Esc') }),
  key('tab', () => tl('Tab', 'Tabulation'), { cap: () => tl('Tab', 'Tab') }),
  navIcon('left', 'i-lucide-arrow-left', () => tl('Left arrow', 'Flèche gauche')),
  navIcon('up', 'i-lucide-arrow-up', () => tl('Up arrow', 'Flèche haut')),
  navIcon('down', 'i-lucide-arrow-down', () => tl('Down arrow', 'Flèche bas')),
  navIcon('right', 'i-lucide-arrow-right', () => tl('Right arrow', 'Flèche droite')),
  navIcon('enter', 'i-lucide-corner-down-left', () => tl('Enter', 'Entrée')),
  key('ctrl-c', () => tl('Ctrl+C', 'Ctrl+C'), { send: 'ctrl+c', cap: () => '^C', danger: true }),
  navIcon('backspace', 'i-lucide-delete', () => tl('Backspace', 'Retour arrière')),
  // Short key caps keep the strip compact; screen readers get the full name.
  key('home', () => tl('Home', 'Début'), { cap: () => tl('Home', 'Début') }),
  key('end', () => tl('End', 'Fin'), { cap: () => tl('End', 'Fin') }),
  key('pageup', () => tl('PgUp', 'Page précédente'), { cap: () => tl('PgUp', 'Pg préc') }),
  key('pagedown', () => tl('PgDn', 'Page suivante'), { cap: () => tl('PgDn', 'Pg suiv') }),
  key('delete', () => tl('Delete', 'Supprimer'), { cap: () => tl('Del', 'Suppr') }),
  key('insert', () => tl('Insert', 'Insérer'), { cap: () => tl('Ins', 'Inser') }),
  { id: 'alt', kind: 'modifier', modifier: 'alt', label: () => t('Alt'), cap: () => t('Alt') },
  { id: 'shift', kind: 'modifier', modifier: 'shift', label: () => t('Shift'), cap: () => t('Shift') },
  upper('y'), upper('n'),
  ...PHONE_KEY_IDS.filter(id => /^f\d+$/.test(id)).map(upper),
]

export const phoneKeyName = (k: PhoneKey) => (k.name || k.label)()

export const PHONE_KEYS = Object.fromEntries(KEYS.map(k => [k.id, k])) as Record<PhoneKeyId, PhoneKey>
