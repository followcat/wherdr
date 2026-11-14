// Which layout the app uses for a window size.
// - phone: one view at a time (list, then agent).
// - computer ("desk"): list as a sidebar, agent on the right. From 900 px
//   wide, and also on a tablet in portrait (at least 700 × 700: iPad mini
//   744 × 1133, iPad Air 820 × 1180). A phone in landscape stays a phone.
// - slim: a computer layout narrower than 1024 px (tablet in portrait). The
//   list stays a narrow column and slides over the agent when opened, so the
//   conversation keeps the full width.
// A touch tablet is also recognised by its screen (shortest side ≥ 700 px,
// coarse pointer): the on-screen keyboard shortens the window but not the
// screen, so the layout and the 44 px targets do not change when it opens.
// The CSS uses the same queries (app/assets/css/main.css): keep them in sync
// (tests/layoutMode.test.ts checks it).
const TOUCH_TABLET = '(min-width: 700px) and (min-device-width: 700px) and (min-device-height: 700px) and (pointer: coarse)'
export const DESK_QUERY = `(min-width: 900px), (min-width: 700px) and (min-height: 700px), ${TOUCH_TABLET}`
// The exact complement of DESK_QUERY, without level 4 syntax.
const SHORT = '(max-width: 899px) and (max-height: 699px)'
export const PHONE_QUERY = `(max-width: 699px), ${SHORT} and (max-device-width: 699px), ${SHORT} and (max-device-height: 699px), ${SHORT} and (pointer: fine), ${SHORT} and (pointer: none)`
// Tablet: 44 px targets (with a coarse pointer), Enter rule, slim layout.
export const TABLET_QUERY = `(min-width: 700px) and (min-height: 700px), ${TOUCH_TABLET}`
export const TOUCH_TABLET_QUERY = `(min-width: 700px) and (min-height: 700px) and (pointer: coarse), ${TOUCH_TABLET}`
export const SLIM_MAX = 1023
export const SLIM_QUERY = `(max-width: ${SLIM_MAX}px) and (min-width: 700px) and (min-height: 700px), (max-width: ${SLIM_MAX}px) and (min-width: 700px) and (min-device-width: 700px) and (min-device-height: 700px) and (pointer: coarse)`

// The screen (not the window) of a touch device: shortest side ≥ 700 px.
export interface Screen { width: number, height: number, coarse: boolean }
export function isTouchTabletScreen(s?: Screen): boolean {
  return Boolean(s && s.coarse && Math.min(s.width, s.height) >= 700)
}

export function isDesk(width: number, height: number, screen?: Screen): boolean {
  return width >= 900 || (width >= 700 && height >= 700) || (width >= 700 && isTouchTabletScreen(screen))
}

// Tablet: shortest side at least 700 px (iPad mini included), or a touch
// tablet's screen with a window at least 700 px wide (keyboard open). A large
// phone in landscape (932 × 430) is not one: it keeps its layout.
export function isTablet(width: number, height: number, screen?: Screen): boolean {
  return Math.min(width, height) >= 700 || (width >= 700 && isTouchTabletScreen(screen))
}

export function isSlim(width: number, height: number, screen?: Screen): boolean {
  return isDesk(width, height, screen) && isTablet(width, height, screen) && width <= SLIM_MAX
}

// State of the agent list on a computer layout.
// docked: full sidebar; rail: narrow column; drawer: full list over the agent.
export type ListMode = 'phone' | 'docked' | 'rail' | 'drawer'
export function listMode(o: { desk: boolean, slim: boolean, collapsed: boolean, drawerOpen: boolean }): ListMode {
  if (!o.desk) return 'phone'
  if (o.slim) return o.drawerOpen ? 'drawer' : 'rail'
  return o.collapsed ? 'rail' : 'docked'
}

// Proof of a hardware keyboard: detector keys — arrows, Escape, Tab, or a
// ⌘ / Ctrl / Alt chord. Some soft keyboards do send these, so a key only
// counts while no on-screen keyboard is open (the kbOpen gate, useViewport).
export function provesHardwareKeyboard(e: { key: string, metaKey: boolean, ctrlKey: boolean, altKey: boolean }): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true
  return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Tab'].includes(e.key)
}

// Enter in the message field: sends on a computer, a narrow window included
// (no touch screen, so no on-screen keyboard). On a touch screen Enter adds a
// line (the button sends), unless it is a tablet in the computer layout with
// a proven hardware keyboard and no on-screen keyboard showing. When in
// doubt: a line.
export function enterSends(o: { desk: boolean, touch: boolean, tablet: boolean, hardwareKeyboard: boolean, softKeyboard: boolean }): boolean {
  if (!o.touch) return true
  return o.desk && o.tablet && o.hardwareKeyboard && !o.softKeyboard
}

// Settings as a side panel next to the conversation (computer, wide window).
// The CSS uses the same width (app/assets/css/main.css, .settings-panel).
export const SIDE_PANEL_QUERY = '(min-width: 1280px)'
