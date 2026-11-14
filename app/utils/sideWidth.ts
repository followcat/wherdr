// Width of the left sidebar (agent list, computer), set with
// the handle on its right edge and kept on the device. null: 340 px (CSS).
export const LIST_DEFAULT = 340
export const LIST_MIN = 280
export const LIST_MAX = 560
export const LIST_MAX_RATIO = 0.45
const LIST_KEY = 'listWidth'

// Bounds: 280 to 560 px, and at most 45 % of the window (the agent keeps the rest);
// window too narrow: the minimum wins.
export function clampListWidth(w: number, viewport: number): number {
  const max = Math.max(LIST_MIN, Math.min(LIST_MAX, Math.floor(viewport * LIST_MAX_RATIO)))
  return Math.round(Math.min(max, Math.max(LIST_MIN, w)))
}

// CSS value of --side: also clamped in CSS, the window may shrink later.
export function listWidthCss(w: number): string {
  return `clamp(${LIST_MIN}px, ${w}px, ${LIST_MAX_RATIO * 100}vw)`
}

export function readListWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(LIST_KEY))
    return Number.isFinite(v) && v >= LIST_MIN && v <= LIST_MAX ? Math.round(v) : null
  } catch { return null }
}

export function saveListWidth(w: number | null) {
  try {
    if (w === null) localStorage.removeItem(LIST_KEY)
    else localStorage.setItem(LIST_KEY, String(w))
  } catch { /* stockage indisponible */ }
}

// List collapsed to a narrow column (sidebar button), kept on the device.
export const LIST_RAIL = 56
const RAIL_KEY = 'listCollapsed'

export function readListCollapsed(): boolean {
  try { return localStorage.getItem(RAIL_KEY) === '1' }
  catch { return false }
}

export function saveListCollapsed(collapsed: boolean) {
  try {
    if (collapsed) localStorage.setItem(RAIL_KEY, '1')
    else localStorage.removeItem(RAIL_KEY)
  } catch { /* stockage indisponible */ }
}

// Width of the side panel beside the conversation (Settings, or a place an
// agent opens), set with the handle on its left edge and kept on the device.
// null: the CSS default, clamp(440px, 36vw, 560px).
export const PANEL_MIN = 400
// The conversation keeps at least this much beside the panel.
export const CONVERSATION_MIN = 480
const PANEL_KEY = 'sidePanelWidth'

// Bounds: at least 400 px, and the conversation (between the list's right edge
// and the panel) keeps 480 px; window too narrow: the minimum wins.
export function clampPanelWidth(w: number, viewport: number, listRight: number): number {
  const max = Math.max(PANEL_MIN, viewport - listRight - CONVERSATION_MIN)
  return Math.round(Math.min(max, Math.max(PANEL_MIN, w)))
}

// CSS value of --settings-panel: also clamped in CSS, the window or the list may change later.
export function panelWidthCss(w: number): string {
  return `clamp(${PANEL_MIN}px, ${w}px, calc(100vw - var(--side) - ${CONVERSATION_MIN}px))`
}

export function readPanelWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(PANEL_KEY))
    return Number.isFinite(v) && v >= PANEL_MIN && v <= 4000 ? Math.round(v) : null
  } catch { return null }
}

export function savePanelWidth(w: number | null) {
  try {
    if (w === null) localStorage.removeItem(PANEL_KEY)
    else localStorage.setItem(PANEL_KEY, String(w))
  } catch { /* storage unavailable */ }
}
