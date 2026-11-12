// Glyphs omp draws differently with each of its symbol presets (setting
// `symbolPreset`: unicode, nerd font, ascii; omp 18.6 packages/tui theme).
// Screen readers of omp (choices.ts, models.ts, ompSelector.ts) build their
// patterns from these lists, in this order: unicode, nerd, ascii.
export const OMP_ESC = ['⎋', '\u{F12B7}', 'Esc'] // key.esc ("⎋ to cancel")
export const OMP_ENTER = ['⏎', '\u{F0311}', 'Enter'] // key.enter
export const OMP_UP_DOWN = ['↑/↓', 'Up/Down'] // key.up "/" key.down (same arrows in nerd)
export const OMP_CURSOR = ['❯', '\uF054', '>'] // nav.cursor
export const OMP_SEARCH = ['🔍', '\uF002', '[/]'] // icon.search
export const OMP_CURRENT = ['●', '\uF111', '[x]'] // status.enabled (model selector "current" mark)

// Regex alternation of a glyph list, for `new RegExp`.
export const ompAlt = (glyphs: readonly string[]) => `(?:${glyphs.map(g => g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
