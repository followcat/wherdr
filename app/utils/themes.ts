// App themes: wherdr's own (Titanium, the default, whose dark palette is
// main.css's first paint), themes inspired by the coding agents, and a few
// classic palettes. Every theme has a dark and a light palette; the mode
// (Dark, Light, System) picks one. Each palette gives a few base colors; the
// surfaces, lines and secondary texts are derived from them (color-mix), to
// keep the same structure everywhere. Applied through the data-theme and
// data-mode attributes of <html>.

export interface ThemeColors {
  bg: string // background
  bg2: string // sidebar, windows
  surface: string // cards
  line: string // thin lines
  text: string
  muted: string
  dim: string
  accent: string // the equivalent of herdr.dev's mauve
  green: string
  coral: string
  ochre: string
  rose: string
  blue: string
  teal: string
  lav?: string
  onAccent?: string // text on the accent (default: the background)
  // Fine-tuning (otherwise derived): user bubbles, input field
  // outline, state colors (default: blue / pink / teal).
  surface2?: string
  inputLine?: string
  selection?: string // base color of the text selection (default: the accent)
  ring?: string // second color gliding around the focused field (default: the accent)
  working?: string
  blocked?: string
  done?: string
}
// Section of the theme picker: wherdr's own themes, themes inspired by the
// coding agents, then classic editor palettes.
// The user's own themes (customThemes.ts) follow, in a Custom section.
export const THEME_GROUPS = ['wherdr', 'agents', 'classic'] as const
export type ThemeGroup = typeof THEME_GROUPS[number] | 'custom'
export interface ThemeDef {
  id: string
  label: string
  group: ThemeGroup
  author?: string
  c: ThemeColors // dark palette
  // xterm ANSI palette: black, red, green, yellow, blue, magenta, cyan, white, then the bright ones.
  ansi: string[]
  light: ThemeColors // light palette; its ANSI colors come from it (lightAnsi)
}
// One theme in one mode: what the page and the terminal paint.
export interface ThemeVariant {
  id: string
  label: string
  light: boolean
  c: ThemeColors
  ansi: string[]
}

export const THEMES: ThemeDef[] = [
  {
    // wherdr Titanium — omp's titanium, calmer: background #12151b, surfaces
    // #1a1e26, lines #2a3038, an electric blue #1fb2ff as signature (accent
    // 7.7:1, background text on accent 7.7:1), also the second color of the
    // gliding focus ring: the agent's color glides to Titanium blue.
    // Text #e6eaf2 (15.2:1), muted #9da5b4 (7.4:1), dim #828a9a (5.3:1).
    // States: working violet #a98bff (the gradient's middle), your turn amber
    // #ffb347, ready green #00f28a.
    id: 'wherdr-titanium', label: 'wherdr Titanium', group: 'wherdr',
    c: {
      bg: '#12151b', bg2: '#0d1015', surface: '#1a1e26', line: '#2a3038',
      text: '#e6eaf2', muted: '#9da5b4', dim: '#828a9a',
      accent: '#1fb2ff', green: '#00f28a', coral: '#ff7b86', ochre: '#ffb347', rose: '#ff4757', blue: '#1fb2ff', teal: '#00dbe4', lav: '#a98bff',
      selection: '#1fb2ff', ring: '#1fb2ff', working: '#a98bff', blocked: '#ffb347', done: '#00f28a',
    },
    ansi: ['#2f3540', '#ff4757', '#00f28a', '#f0c040', '#1fb2ff', '#d06fed', '#00dbe4', '#c3c9d3',
      '#6b7280', '#ff7b86', '#6bffb0', '#fddb72', '#6ec9ff', '#e69dfc', '#75efea', '#f7f9fc'],
    // Light: cool titanium paper, the electric blue deepened to #0b6fb8 for text and focus.
    light: {
      bg: '#eef1f5', bg2: '#e5e9ef', surface: '#f6f8fb', line: '#c5ccd7', text: '#1a202b', muted: '#4f5868', dim: '#6a7384',
      accent: '#0b6fb8', green: '#0a7a4b', coral: '#b8434f', ochre: '#94600a', rose: '#c22d3a', blue: '#0b6fb8', teal: '#077880',
      lav: '#6447c9', onAccent: '#ffffff', selection: '#1fb2ff', ring: '#0b6fb8', working: '#6447c9', blocked: '#94600a',
      done: '#0a7a4b',
    },
  },
  {
    // wherdr Neon — proposal for wherdr's own identity. A cold blue-black
    // terminal lit by a "volt" chartreuse #c6ff3d (signature: neither Herdr's
    // mauve nor omp's pink, and far from Claude orange / Codex blue), paired
    // with an ion cyan #2ee6ff for activity and the gliding focus ring.
    // Background #0d1117, surfaces #141a22, lines #263040, text #e6edf5
    // (16:1), muted #9aa7b8 (7.7:1), dim #75839a (4.9:1). States: working cyan,
    // your turn amber #ff9f1c, ready volt.
    id: 'wherdr-neon', label: 'wherdr Neon', group: 'wherdr',
    c: {
      bg: '#0d1117', bg2: '#090c11', surface: '#141a22', line: '#263040',
      text: '#e6edf5', muted: '#9aa7b8', dim: '#75839a',
      accent: '#c6ff3d', green: '#7dff6b', coral: '#ff8a5c', ochre: '#ff9f1c', rose: '#ff4d6d', blue: '#4d9dff', teal: '#2ee6ff', lav: '#a8b8ff',
      selection: '#2ee6ff', ring: '#2ee6ff', working: '#2ee6ff', blocked: '#ff9f1c', done: '#c6ff3d',
    },
    ansi: ['#263040', '#ff4d6d', '#7dff6b', '#ffd23d', '#4d9dff', '#c38bff', '#2ee6ff', '#c9d3df',
      '#5a6779', '#ff7a90', '#c6ff3d', '#ffe57a', '#80bbff', '#d9b3ff', '#8cf3ff', '#f5f9fc'],
    // Light: cool gray paper; volt turns olive #4a7300 and ion cyan deep teal #08778c to read on it.
    light: {
      bg: '#edf1f3', bg2: '#e4e9ed', surface: '#f5f8f9', line: '#c3cdd6', text: '#131a22', muted: '#4b5766', dim: '#667283',
      accent: '#4a7300', green: '#2b7d1c', coral: '#b54d26', ochre: '#9a5a00', rose: '#c02a4a', blue: '#2560c4', teal: '#08778c',
      lav: '#5558c8', onAccent: '#ffffff', selection: '#08778c', ring: '#08778c', working: '#08778c', blocked: '#9a5a00',
      done: '#4a7300',
    },
  },
  {
    // wherdr Graphite — Codex / Terminal's neutral graphite (no blue tint in
    // the background: #141414, surfaces #1c1c1c, lines #333333) lit by an
    // electric violet #b65cff, with its
    // cyan duo #2ee6ff for the gliding focus ring and activity. Sober: the
    // colors live in the accent, the states and the terminal. Text #ececec
    // (15.6:1), muted #a3a3a3 (7.3:1), dim #8a8a8a (5.3:1), accent 5.2:1,
    // background text on accent 5.2:1. States: working cyan, your turn amber
    // #ffa630, ready mint #5af78e. ANSI magenta is pink #ff5fd2, away from the accent.
    id: 'wherdr-graphite', label: 'wherdr Graphite', group: 'wherdr',
    c: {
      bg: '#141414', bg2: '#0f0f0f', surface: '#1c1c1c', line: '#333333',
      text: '#ececec', muted: '#a3a3a3', dim: '#8a8a8a',
      accent: '#b65cff', green: '#5af78e', coral: '#ff8a5c', ochre: '#ffa630', rose: '#ff5370', blue: '#4d9dff', teal: '#2ee6ff', lav: '#c9a8ff',
      selection: '#b65cff', ring: '#2ee6ff', working: '#2ee6ff', blocked: '#ffa630', done: '#5af78e',
    },
    ansi: ['#2e2e2e', '#ff5370', '#5af78e', '#f4d35e', '#4d9dff', '#ff5fd2', '#2ee6ff', '#d4d4d4',
      '#6b6b6b', '#ff7a90', '#8affb0', '#ffe58a', '#80bbff', '#ff9be6', '#8cf3ff', '#ffffff'],
    // Light: neutral gray paper, the violet deepened to #7f35d1, deep teal focus duo.
    light: {
      bg: '#efefef', bg2: '#e6e6e6', surface: '#f7f7f7', line: '#cacaca', text: '#1b1b1b', muted: '#525252', dim: '#6b6b6b',
      accent: '#7f35d1', green: '#17793f', coral: '#b54d26', ochre: '#985a00', rose: '#bd2747', blue: '#2560c4', teal: '#08778c',
      lav: '#6c4bc9', onAccent: '#ffffff', selection: '#7f35d1', ring: '#08778c', working: '#08778c', blocked: '#985a00',
      done: '#17793f',
    },
  },
  {
    // Claude Code (v2.1.283, dark theme), colors captured in the terminal
    // (herdr pane read --format ansi): brand orange #d77757 (logo,
    // spinner), secondary text #999999, input field lines #888888,
    // user bubble #373737, permission #b1b9f9 (also inline
    // code), success #4eba65, warning / auto mode #ffc107, error
    // #ff6b80, plan mode #48968c, accept edits #af87ff, bash mode #fd5db1,
    // diffs +#50c850 / −#dc5a5a, monokai highlighting (#66d9ef, #a6e22e,
    // #e6db74). Background: the terminal's, here a neutral dark gray.
    id: 'claude-code', label: 'Claude Code', group: 'agents',
    c: {
      bg: '#1a1a1a', bg2: '#151515', surface: '#222222', surface2: '#373737', line: '#3a3a3a', inputLine: '#888888',
      text: '#ffffff', muted: '#999999', dim: '#707070',
      accent: '#d77757', green: '#4eba65', coral: '#d77757', ochre: '#ffc107', rose: '#ff6b80', blue: '#b1b9f9', teal: '#48968c', lav: '#b1b9f9',
      working: '#d77757', blocked: '#b1b9f9', done: '#4eba65',
    },
    ansi: ['#3a3a3a', '#dc5a5a', '#50c850', '#e6db74', '#b1b9f9', '#af87ff', '#66d9ef', '#d0d0d0',
      '#707070', '#ff6b80', '#4eba65', '#ffc107', '#b1b9f9', '#fd5db1', '#66d9ef', '#ffffff'],
    // Light: warm paper, Claude orange deepened to #a94d2d, permission blue-violet #4a52bd.
    light: {
      bg: '#f3f1ed', bg2: '#eae7e1', surface: '#f9f8f5', surface2: '#e5e1da', line: '#d0cbc2', inputLine: '#8c867c',
      text: '#1e1d1b', muted: '#5b5852', dim: '#736f68', accent: '#a94d2d', green: '#25733a', coral: '#a94d2d', ochre: '#8a5d00',
      rose: '#b8344a', blue: '#4a52bd', teal: '#2b7069', lav: '#4a52bd', onAccent: '#ffffff', working: '#a94d2d',
      blocked: '#4a52bd', done: '#25733a',
    },
  },
  {
    // Codex CLI (v0.156.1), captured in the terminal: Codex mostly relies
    // on attributes (bold, dim, inverse for the selection) and the
    // terminal's ANSI colors (green = success and additions, red = errors and
    // deletions, cyan = diff headers); in true colors: blue
    // #63a8f8 (links, commands, update), model #f6e2b7 and folder
    // #abdfa7 on the status line, warning #c4a767, dimmed bullet
    // #808080, command highlighting #89b4fa / #9399b2 / #eba0ac. Background:
    // the terminal's, here a neutral dark gray.
    id: 'codex', label: 'Codex', group: 'agents',
    c: {
      bg: '#171717', bg2: '#121212', surface: '#1f1f1f', line: '#3c3c3c',
      text: '#e6e6e6', muted: '#9a9a9a', dim: '#808080',
      accent: '#63a8f8', green: '#abdfa7', coral: '#eba0ac', ochre: '#c4a767', rose: '#e5737b', blue: '#63a8f8', teal: '#63c5d8', lav: '#89b4fa',
      working: '#63a8f8', done: '#abdfa7',
    },
    ansi: ['#2a2a2a', '#e5737b', '#8fcf8a', '#e7c787', '#89b4fa', '#c9a0e8', '#63c5d8', '#d4d4d4',
      '#6b6b6b', '#f38b95', '#abdfa7', '#f6e2b7', '#63a8f8', '#d7b4f0', '#8ad6e6', '#ffffff'],
    // Light: neutral paper, Codex blue deepened to #1a68c9.
    light: {
      bg: '#f1f2f4', bg2: '#e8e9ec', surface: '#f8f9fa', line: '#cdd0d6', text: '#1a1c20', muted: '#545860', dim: '#6c7078',
      accent: '#1a68c9', green: '#29742f', coral: '#ad4456', ochre: '#806210', rose: '#bb3a44', blue: '#1a68c9', teal: '#0a7385',
      lav: '#4b67c9', onAccent: '#ffffff', working: '#1a68c9', done: '#29742f',
    },
  },
  {
    // omp / oh-my-pi (v18.4.10), built-in dark theme "titanium" (the
    // default `theme.dark`, packages/tui/src/theme/defaults/titanium.json,
    // checked with herdr pane read --format ansi): background #151820,
    // chrome / status line #0f1216, widgets #1c2029, borders #2a3038, text
    // #e8ecf4, muted #9ca3b0, dim #6b7280, electric blue #00b4ff (spinner,
    // headings, model), success / diff + #00ff88, error / diff − #ff4757,
    // warning #ffb347, gold #d4c090. The accent and the selection come from
    // the logo gradient (welcome.ts GRADIENT_STOPS: pink #f84fcc → violet
    // #9362f4 → cyan #00dbe4), next to the magenta of the omp pi.
    id: 'omp', label: 'omp', group: 'agents',
    c: {
      bg: '#151820', bg2: '#0f1216', surface: '#1c2029', line: '#2a3038',
      text: '#e8ecf4', muted: '#9ca3b0', dim: '#6b7280',
      accent: '#f84fcc', green: '#00ff88', coral: '#ff7b86', ochre: '#ffb347', rose: '#ff4757', blue: '#00b4ff', teal: '#13d1cd', lav: '#e69dfc',
      selection: '#9362f4', working: '#00b4ff', blocked: '#ffb347', done: '#00ff88',
    },
    ansi: ['#3b424d', '#ff4757', '#00ff88', '#f0c040', '#00b4ff', '#d06fed', '#13d1cd', '#c3c9d3',
      '#6b7280', '#ff7b86', '#6bffb0', '#fddb72', '#6ec9ff', '#e69dfc', '#75efea', '#f7f9fc'],
    // Light: omp's light theme (muted teal, blue, green, warm warning), on a softer gray than its
    // #f8f8f8; the logo pink deepened to #a8287f, violet selection and focus.
    light: {
      bg: '#f0f1f4', bg2: '#e7e9ee', surface: '#f7f8fa', surface2: '#e3e5ea', line: '#cbcfd7', text: '#20242d', muted: '#545a66',
      dim: '#6b717d', accent: '#a8287f', green: '#2f7340', coral: '#a94a54', ochre: '#82621c', rose: '#ad3f3f', blue: '#38689a',
      teal: '#386b6b', lav: '#7048b8', onAccent: '#ffffff', selection: '#7a4fe0', ring: '#7048b8', working: '#38689a',
      blocked: '#82621c', done: '#2f7340',
    },
  },
  {
    id: 'vesper', label: 'Vesper', group: 'classic',
    c: {
      bg: '#101010', bg2: '#141414', surface: '#1a1a1a', line: '#2e2e2e', text: '#ffffff', muted: '#a0a0a0', dim: '#707070',
      accent: '#ffc799', green: '#99ffe4', coral: '#ffc799', ochre: '#e6b99d', rose: '#ff8080', blue: '#aca1cf', teal: '#99ffe4', lav: '#b9aeda',
    },
    ansi: ['#101010', '#f5a191', '#90b99f', '#e6b99d', '#aca1cf', '#e29eca', '#ea83a5', '#a0a0a0',
      '#7e7e7e', '#ff8080', '#99ffe4', '#ffc799', '#b9aeda', '#ecaad6', '#f591b2', '#ffffff'],
    // Light: warm paper; Vesper's peach becomes burnt orange #a2521b, its mint deep green #1b7563.
    light: {
      bg: '#f4f1ed', bg2: '#ebe7e2', surface: '#faf8f5', line: '#d3ccc3', text: '#161616', muted: '#5a5650', dim: '#736e67',
      accent: '#a2521b', green: '#1b7563', coral: '#a2521b', ochre: '#8a5a33', rose: '#b83636', blue: '#5f4fa0', teal: '#1b7563',
      lav: '#695aa3', onAccent: '#ffffff',
    },
  },
  {
    id: 'gruvbox', label: 'Gruvbox', group: 'classic',
    c: {
      bg: '#282828', bg2: '#1d2021', surface: '#32302f', line: '#504945', text: '#ebdbb2', muted: '#bdae93', dim: '#928374',
      accent: '#fabd2f', green: '#b8bb26', coral: '#fe8019', ochre: '#fabd2f', rose: '#fb4934', blue: '#83a598', teal: '#8ec07c', lav: '#d3869b',
    },
    ansi: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
    // Light: Gruvbox's own light palette (bg0_soft, faded accents), yellow deepened to #8a5710.
    light: {
      bg: '#f2e5bc', bg2: '#ebdbb2', surface: '#f9f0cc', line: '#d5c4a1', text: '#3c3836', muted: '#5d544c', dim: '#7c6f64',
      accent: '#8a5710', green: '#6a650b', coral: '#a03702', ochre: '#8a5710', rose: '#9d0006', blue: '#076678', teal: '#3c6f50',
      lav: '#8f3f71', onAccent: '#fbf1c7',
    },
  },
  {
    id: 'kanagawa', label: 'Kanagawa', group: 'classic',
    c: {
      bg: '#1f1f28', bg2: '#16161d', surface: '#2a2a37', line: '#54546d', text: '#dcd7ba', muted: '#c8c093', dim: '#727169',
      accent: '#957fb8', green: '#98bb6c', coral: '#ffa066', ochre: '#e6c384', rose: '#e46876', blue: '#7e9cd8', teal: '#7aa89f', lav: '#7fb4ca',
    },
    ansi: ['#090618', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093',
      '#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba'],
    // Light: Kanagawa Lotus (lotusWhite, lotusInk, lotusViolet), muted tones deepened for 4.5:1.
    light: {
      bg: '#f2ecbc', bg2: '#e7dba0', surface: '#f6f1cc', line: '#d7cc96', text: '#43436c', muted: '#5d5c66', dim: '#77766d',
      accent: '#624c83', green: '#56703a', coral: '#9a5200', ochre: '#6c6638', rose: '#b6354a', blue: '#4d699b', teal: '#4b6f68',
      lav: '#4f6a77', onAccent: '#f2ecbc',
    },
  },
]

export const DEFAULT_THEME = 'wherdr-titanium'
export const themeById = (id: string | null | undefined) => THEMES.find(t => t.id === id)

// Picker sections in THEME_GROUPS order (the default theme leads THEMES), then the custom themes.
export const themeSections = (custom: ThemeDef[] = []) => [
  ...THEME_GROUPS.map(group => ({ group: group as ThemeGroup, themes: THEMES.filter(t => t.group === group) })),
  ...(custom.length ? [{ group: 'custom' as ThemeGroup, themes: custom }] : []),
]

// The 2.x light themes, now the Light mode of a kept theme.
const LIGHT_THEMES: Record<string, string> = { 'catppuccin-latte': DEFAULT_THEME, 'omp-light': 'omp' }
export const legacyLightTheme = (v: string | null | undefined) => (v ? LIGHT_THEMES[v] : undefined)

// Theme choice read from the device: an id that no longer exists (removed
// theme) falls back to the default instead of showing a raw id in Settings.
// A custom theme's id is kept: the list of custom themes may load later.
export const storedThemeChoice = (v: string | null | undefined) =>
  themeById(v)?.id ?? legacyLightTheme(v) ?? (v?.startsWith('custom-') ? v : DEFAULT_THEME)

export const THEME_MODES = ['dark', 'light', 'system'] as const
export type ThemeMode = typeof THEME_MODES[number]
export const storedThemeMode = (v: string | null | undefined): ThemeMode =>
  (THEME_MODES as readonly string[]).includes(v ?? '') ? v as ThemeMode : 'dark'
export const modeIsLight = (mode: ThemeMode, systemLight: boolean) => mode === 'light' || (mode === 'system' && systemLight)

// Light terminals: the dark text first, the palette's own state colors, pale
// grays for "white" (rarely used as text on a light background).
export const lightAnsi = (c: ThemeColors) => {
  const magenta = c.lav || c.accent
  return [c.text, c.rose, c.green, c.ochre, c.blue, magenta, c.teal, c.dim,
    c.muted, c.coral, c.green, c.ochre, c.accent, magenta, c.teal, c.line]
}

export const themeVariant = (th: ThemeDef, light: boolean): ThemeVariant =>
  ({ id: th.id, label: th.label, light, c: light ? th.light : th.c, ansi: light ? lightAnsi(th.light) : th.ansi })

// CSS variables for the selected palette; main.css holds Titanium's first paint.
// Every variable is set, so a light palette never keeps one of its dark one's.
export function themeVars(th: ThemeVariant): Record<string, string> {
  const c = th.c
  const mix = (a: string, p: number, b = 'var(--bg)') => `color-mix(in srgb, ${a} ${p}%, ${b})`
  return {
    '--bg': c.bg, '--bg-2': c.bg2, '--surface': c.surface,
    '--surface-2': c.surface2 || mix('var(--text)', th.light ? 9 : 7),
    '--surface-3': mix('var(--text)', th.light ? 14 : 11),
    '--line': c.line,
    '--line-soft': mix('var(--line)', 60),
    '--line-strong': mix('var(--text)', th.light ? 38 : 30),
    '--text': c.text,
    '--text-2': mix('var(--text)', 86),
    '--text-3': mix('var(--text)', 72),
    '--text-strong': th.light ? 'color-mix(in srgb, var(--text) 70%, #000)' : 'color-mix(in srgb, var(--text) 75%, #fff)',
    '--muted': c.muted, '--dim': c.dim, '--lav': c.lav || c.accent,
    '--mauve': c.accent, '--accent': c.accent, '--on-accent': c.onAccent || c.bg,
    '--green': c.green, '--coral': c.coral, '--ochre': c.ochre, '--rose': c.rose, '--blue': c.blue, '--teal': c.teal,
    '--code-bg': th.light ? mix('var(--text)', 5) : 'color-mix(in srgb, #000 22%, var(--bg))',
    // Agents' brand colors (logos and name in the list), identical in all themes:
    // orange of the Claude Code crab, blue-violet of the Codex icon, magenta of the omp pi.
    '--claude': '#d77757', '--codex': '#7a9dff', '--omp': '#c467e0',
    '--selection': `color-mix(in srgb, ${c.selection || 'var(--accent)'} ${th.light ? 22 : 32}%, transparent)`,
    '--ring-2': c.ring || 'var(--accent)',
    '--shadow': th.light ? 'rgba(60, 60, 80, .16)' : 'rgba(0, 0, 0, .5)',
    'color-scheme': th.light ? 'light' : 'dark',
    '--input-line': c.inputLine || 'var(--line)',
    '--working': c.working || c.blue,
    '--blocked': c.blocked || c.rose,
    '--done': c.done || c.teal,
    '--idle': c.done || c.teal,
  }
}

// Stylesheet of all themes: [data-theme="…"] { --bg: … } for the dark palette,
// [data-theme="…"][data-mode="light"] for the light one.
export function themesCss(themes = THEMES): string {
  const rule = (sel: string, v: ThemeVariant) => `:root${sel}{${Object.entries(themeVars(v)).map(([k, x]) => `${k}:${x}`).join(';')}}`
  return themes.flatMap(t => [
    ...(t.id === DEFAULT_THEME ? [] : [rule(`[data-theme="${t.id}"]`, themeVariant(t, false))]),
    rule(`[data-theme="${t.id}"][data-mode="light"]`, themeVariant(t, true)),
  ]).join('\n')
}

// xterm theme: theme background and text, ANSI palette.
export function xtermTheme(th: ThemeVariant) {
  const a = th.ansi
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
  const out: Record<string, string> = {
    background: th.c.bg, foreground: th.c.text, cursor: th.c.accent, cursorAccent: th.c.bg,
    selectionBackground: hexAlpha(th.c.selection || th.c.accent, th.light ? 0.25 : 0.32),
  }
  names.forEach((n, i) => {
    out[n] = a[i]!
    out[`bright${n[0]!.toUpperCase()}${n.slice(1)}`] = a[i + 8]!
  })
  return out
}
function hexAlpha(hex: string, alpha: number) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${alpha})` : hex
}

// WCAG relative luminance and contrast ratio of two #rrggbb colors.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
// A palette's contrast below WCAG AA: body and muted text 4.5:1 on every
// background, the accent and focus ring 3:1 (non-text), borders a visible step.
export function contrastIssues(c: ThemeColors): string[] {
  const found: string[] = []
  const need = (what: string, ratio: number, min: number) => { if (ratio < min) found.push(`${what} ${ratio.toFixed(2)} < ${min}`) }
  for (const bg of ['bg', 'bg2', 'surface'] as const) {
    need(`text on ${bg}`, contrast(c.text, c[bg]), 4.5)
    need(`muted on ${bg}`, contrast(c.muted, c[bg]), 4.5)
  }
  need('line on bg', contrast(c.line, c.bg), 1.3)
  need('line on surface', contrast(c.line, c.surface), 1.2)
  need('focus ring', contrast(c.ring || c.accent, c.bg), 3)
  need('accent', contrast(c.accent, c.bg), 3)
  return found
}
