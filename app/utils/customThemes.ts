// Custom themes: made in Settings › Appearance from any theme, shared as a
// JSON file. The file and the synced setting use one format:
//   { "wherdr": "theme", "version": 1, "name": "…", "author": "…",
//     "dark": { bg, bg2, …, "ansi": [16 colors] }, "light": { bg, bg2, … } }
// Colors are #rrggbb. The light terminal palette is derived (lightAnsi).
import type { ThemeColors, ThemeDef } from './themes'

const REQUIRED = ['bg', 'bg2', 'surface', 'line', 'text', 'muted', 'dim', 'accent', 'green', 'coral', 'ochre', 'rose', 'blue', 'teal'] as const
const OPTIONAL = ['lav', 'onAccent', 'surface2', 'inputLine', 'selection', 'ring', 'working', 'blocked', 'done'] as const
const COLOR = /^#[0-9a-f]{6}$/i
export const THEME_FILE_MAX = 8 * 1024 // bytes of an imported file
export const CUSTOM_THEMES_MAX = 10 // fits the synced setting's 16 KB

export interface ThemeFile {
  wherdr: 'theme'
  version: 1
  name: string
  author?: string
  dark: ThemeColors & { ansi: string[] }
  light: ThemeColors
}

export const themeFile = (th: ThemeDef): ThemeFile => ({
  wherdr: 'theme', version: 1, name: th.label, ...(th.author ? { author: th.author } : {}),
  dark: { ...th.c, ansi: [...th.ansi] }, light: { ...th.light },
})

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function readPalette(v: unknown, where: 'dark' | 'light'): ThemeColors | string {
  if (!isObject(v)) return `"${where}" must be an object of colors`
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === 'ansi' && where === 'dark') continue
    if (!(REQUIRED as readonly string[]).includes(k) && !(OPTIONAL as readonly string[]).includes(k)) return `Unknown color "${where}.${k}"`
    if (typeof x !== 'string' || !COLOR.test(x)) return `"${where}.${k}" is not a #rrggbb color`
    out[k] = x.toLowerCase()
  }
  const missing = REQUIRED.find(k => !out[k])
  return missing ? `"${where}.${missing}" is missing` : out as unknown as ThemeColors
}

// A theme file's content (already parsed) as a custom theme, or why it is refused.
export function readThemeFile(v: unknown, id: string): ThemeDef | string {
  if (!isObject(v) || v.wherdr !== 'theme') return 'Not a wherdr theme file'
  if (v.version !== 1) return 'Unsupported theme file version'
  const name = typeof v.name === 'string' ? v.name.trim() : ''
  if (!name || name.length > 40) return 'The name must be 1 to 40 characters'
  if (v.author !== undefined && (typeof v.author !== 'string' || v.author.length > 60)) return 'The author must be up to 60 characters'
  const c = readPalette(v.dark, 'dark')
  if (typeof c === 'string') return c
  const light = readPalette(v.light, 'light')
  if (typeof light === 'string') return light
  const ansi = (v.dark as Record<string, unknown>).ansi
  if (!Array.isArray(ansi) || ansi.length !== 16 || !ansi.every(x => typeof x === 'string' && COLOR.test(x))) return '"dark.ansi" must be 16 #rrggbb colors'
  return { id, label: name, group: 'custom', ...(v.author ? { author: (v.author as string).trim() } : {}), c, light, ansi: ansi.map(x => (x as string).toLowerCase()) }
}

export const newCustomId = () => `custom-${Math.random().toString(36).slice(2, 10)}`

// Pasted, picked or edited text: size, JSON, then the format.
export function importThemeText(text: string, id = newCustomId()): ThemeDef | string {
  if (new Blob([text]).size > THEME_FILE_MAX) return `The file is larger than ${THEME_FILE_MAX / 1024} KB`
  let v: unknown
  try { v = JSON.parse(text) } catch { return 'Not valid JSON' }
  return readThemeFile(v, id)
}

// The line an importThemeText error points at, when it can be found: the
// parser's position for invalid JSON, else the key the message names.
export function themeErrorLine(text: string, error: string): number | undefined {
  let at = -1
  if (error === 'Not valid JSON') {
    try { JSON.parse(text) } catch (e) {
      const msg = String(e)
      const line = /line (\d+)/.exec(msg)
      if (line) return Number(line[1])
      at = Number(/position (\d+)/.exec(msg)?.[1] ?? -1)
    }
  } else {
    const color = /"(dark|light)\.(\w+)"/.exec(error)
    const key = color?.[1] ?? /\b(name|author|version)\b/.exec(error)?.[1]
    if (key) at = text.search(new RegExp(`"${key}"\\s*:`))
    const inside = at >= 0 && color && !error.endsWith('missing') ? text.indexOf(`"${color[2]}"`, at) : -1
    if (inside >= 0) at = inside
  }
  return at < 0 ? undefined : text.slice(0, at).split('\n').length
}

// The synced setting: an array of theme files with their id; invalid entries are dropped.
export function readCustomThemes(raw: string | null): ThemeDef[] {
  let v: unknown
  try { v = raw ? JSON.parse(raw) : [] } catch { return [] }
  if (!Array.isArray(v)) return []
  return v.flatMap((x) => {
    const th = isObject(x) && typeof x.id === 'string' && x.id.startsWith('custom-') ? readThemeFile(x, x.id) : null
    return th && typeof th !== 'string' ? [th] : []
  }).slice(0, CUSTOM_THEMES_MAX)
}
export const writeCustomThemes = (list: ThemeDef[]) => (list.length ? JSON.stringify(list.map(th => ({ id: th.id, ...themeFile(th) }))) : null)
