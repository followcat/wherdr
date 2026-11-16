// App theme and mode (Dark, Light, System): chosen in Settings (kept on the
// server, so they follow the user across devices: useSyncedSettings.ts),
// applied right away through the data-theme and data-mode attributes of
// <html>, with the color of the iOS bar (theme-color) and the terminal palette.

import { settingsSync, syncedRef } from './useSyncedSettings'
import type { ThemeDef } from '~/utils/themes'
import { CUSTOM_THEMES_MAX, readCustomThemes, writeCustomThemes } from '~/utils/customThemes'
import { BOOT_THEME_KEY } from '#shared/bootTheme'

export const themeChoice = syncedRef<string>('theme', storedThemeChoice, v => v)
export const themeMode = syncedRef<ThemeMode>('themeMode', storedThemeMode, v => v)
// The user's own themes (utils/customThemes.ts), synced like the choice.
export const customThemes = syncedRef<ThemeDef[]>('customThemes', readCustomThemes, writeCustomThemes)
export const findTheme = (id: string | null | undefined) => themeById(id) || customThemes.value.find(t => t.id === id)
// Adds or replaces a custom theme (by id) and shows it. A new one past
// CUSTOM_THEMES_MAX is refused (false): it would be dropped on the next read.
export function saveCustomTheme(th: ThemeDef) {
  const list = customThemes.value
  const at = list.findIndex(t => t.id === th.id)
  if (at < 0 && list.length >= CUSTOM_THEMES_MAX) {
    toast(tl(`At most ${CUSTOM_THEMES_MAX} custom themes: delete one first`), true)
    return false
  }
  customThemes.value = at < 0 ? [...list, th] : list.map((t, i) => (i === at ? th : t))
  themeChoice.value = th.id
  return true
}
export function deleteCustomTheme(id: string) {
  customThemes.value = customThemes.value.filter(t => t.id !== id)
  if (themeChoice.value === id) themeChoice.value = DEFAULT_THEME
}

// A saved 2.x light theme (Catppuccin Latte, omp Light) becomes its family in
// Light mode, saved once so it follows the other devices too.
function migrateLightTheme(raw: string | null) {
  const to = legacyLightTheme(raw)
  if (!to) return
  settingsSync.write('theme', to)
  settingsSync.write('themeMode', 'light')
  themeMode.value = 'light'
}
if (import.meta.client) {
  try { migrateLightTheme(localStorage.getItem('theme')) } catch { /* storage off */ }
  settingsSync.bind('theme', migrateLightTheme)
}

// The system's light / dark preference, followed live in System mode.
const systemLight = ref(false)
if (import.meta.client) {
  const mq = matchMedia('(prefers-color-scheme: light)')
  systemLight.value = mq.matches
  mq.addEventListener('change', () => { systemLight.value = mq.matches })
}

// Theme actually shown, in the mode actually shown.
export const activeTheme = computed(() =>
  themeVariant(findTheme(themeChoice.value) || themeById(DEFAULT_THEME)!, modeIsLight(themeMode.value, systemLight.value)))

// Color of the iOS bar (meta theme-color, set by useHead in app.vue).
export const themeColor = computed(() => activeTheme.value.c.bg)

function apply() {
  const root = document.documentElement
  root.dataset.theme = activeTheme.value.id
  root.dataset.mode = activeTheme.value.light ? 'light' : 'dark'
  // The startup background (nuxt.config.ts) gives way to the theme's styles,
  // and is this theme's next time.
  root.style.removeProperty('--bg')
  try { localStorage.setItem(BOOT_THEME_KEY, JSON.stringify({ bg: themeColor.value, light: activeTheme.value.light })) } catch { /* storage off: Titanium at startup */ }
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', themeColor.value)
}

export function installTheme() {
  if (!document.getElementById('hw-themes')) {
    const style = document.createElement('style')
    style.id = 'hw-themes'
    style.textContent = themesCss()
    document.head.appendChild(style)
  }
  const custom = document.createElement('style')
  custom.id = 'hw-custom-themes'
  document.head.appendChild(custom)
  // Before apply: the custom theme's rules are in place when it is shown.
  watch(customThemes, (list) => { custom.textContent = themesCss(list) }, { immediate: true })
  apply()
  watch(activeTheme, apply)
}

// xterm palette of the theme shown.
export const terminalTheme = computed(() => xtermTheme(activeTheme.value))
