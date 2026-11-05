// Dimensions on iPhone: keyboard, home bar, shortened page (iOS 26).
import { sheetViewport } from '~/utils/sheetViewport'

// Clavier ouvert : hauteur et position de la zone visible au-dessus.
export const kbOpen = ref(false)
export const vvHeight = ref(0)
export const vvTop = ref(0)
// Incremented on each dimension change (the terminal readjusts on it).
export const layoutTick = ref(0)

const fullH = { orient: '', h: 0 }

export function layout() {
  const vv = window.visualViewport
  const h = vv ? vv.height : window.innerHeight
  const top = vv ? vv.offsetTop : 0
  // Keyboard open = the visible area lost more than 120 px compared with the
  // largest height seen in this orientation. (Comparing with innerHeight does not
  // work: with interactive-widget=resizes-content, iOS shrinks both.)
  const orient = screen.width > screen.height || innerWidth > innerHeight ? 'l' : 'p'
  if (orient !== fullH.orient) {
    fullH.orient = orient
    fullH.h = 0
  }
  fullH.h = Math.max(fullH.h, h, window.innerHeight)
  const kb = fullH.h - h > 120
  kbOpen.value = kb
  // A shrink this large only resembles a soft-keyboard open — it cannot be
  // told apart from one here, so geometry must stay bookkeeping and never
  // input evidence: hardwareKeyboard is forged and forgotten by input events
  // alone (useHerdr — a key proves, a touch or a prompt blur forgets).
  vvHeight.value = h
  vvTop.value = top
  document.body.classList.toggle('kb', kb)
  // Bottom sheets follow the visible area (keyboard, iOS scroll offset).
  const sheet = sheetViewport(window.innerHeight, top, h)
  const root = document.documentElement.style
  root.setProperty('--vv-h', `${sheet.height}px`)
  root.setProperty('--vv-top', `${sheet.top}px`)
  root.setProperty('--vv-bottom', `${sheet.bottom}px`)
  layoutTick.value++
}

// Installed app whose page stops above the bottom of the screen (iOS 26 with
// a translucent status bar, or icon installed before the change): the
// bottom safe area would fall into the void.
// Signature of the bug: page under the status bar (non-zero top safe
// area) AND shorter than the screen by as much. With an opaque status bar, the
// page starts below the clock (zero top area) and does reach the bottom.
export function checkShortBottom() {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;padding-top:env(safe-area-inset-top);visibility:hidden'
  document.body.append(probe)
  const safeTop = parseFloat(getComputedStyle(probe).paddingTop) || 0
  probe.remove()
  const portrait = screen.height > screen.width
  const kb = window.visualViewport && innerHeight - window.visualViewport.height > 120
  const missing = screen.height - innerHeight
  document.body.classList.toggle('short-bottom',
    standalone && portrait && !kb && safeTop > 20 && missing >= safeTop - 4)
}

let installed = false
export function installViewport() {
  if (installed) return
  installed = true
  checkShortBottom()
  layout()
  window.addEventListener('resize', checkShortBottom)
  window.addEventListener('resize', layout)
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', layout)
    window.visualViewport.addEventListener('scroll', layout)
  }
}
