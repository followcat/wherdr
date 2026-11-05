// Terminal of a pane: xterm.js connected to /ws/term (Herdr's ANSI frames).
// herdr-core (`web.capabilities.core`): the attach writes the raw stream with
// its history into xterm, which owns the scrollback and the viewport; the
// server owns the size and gets credit back once xterm has written each
// frame (see server/utils/coreTerm.ts).
import { createSocketProbe } from '~/utils/socketProbe'
import { DESK_QUERY } from '~/utils/layoutMode'
// Types only: the code is loaded when a terminal is shown (utils/xtermLoader.ts).
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { WebglAddon } from '@xterm/addon-webgl'
import { loadWebgl, loadXterm } from '~/utils/xtermLoader'
import { reloadIfNewBuild } from '~/composables/useAppVersion'
import { proposeTerminalSize, terminalPixelWidth } from '~/utils/terminalSize'
import { writeTerminalFrame } from '~/utils/terminalFrame'
import { kbOpen } from './useViewport'
import { guardWebglCanvasSize } from '~/utils/terminalRenderer'
import { bindTerminalSelection } from '~/utils/terminalSelection'
import { bindTerminalLinks, type TerminalLinks } from '~/utils/terminalLinks'
import { bindTerminalKeys } from '~/utils/terminalKeys'
import { bindTerminalImagePaste } from '~/utils/terminalPaste'
import { fmtBytes } from '~/utils/bytes'
import { OSC52_MAX_BYTES, bindTerminalOsc52, copyAgentText } from '~/utils/terminalOsc52'
import { uploadPhoto } from '~/utils/photoUpload'
import { terminalClosedText, terminalUnavailableText } from '~/utils/terminalClosed'
import { bindTerminalMouse, terminalCell } from '~/utils/terminalMouse'
import { TERM_FONT, onFontsLoaded } from '~/utils/terminalFont'
import { displayVirtualChord, virtualNavigationBytes, virtualNavigationKeys } from '~/utils/keybarKeys'
import { createCompositionTracker, toggleVirtualModifier, virtualChord, virtualInputAction, type VirtualModifier } from '~/utils/terminalModifiers'
import { captureTerminalScreen, type TerminalCopySnapshot } from '~/utils/terminalCopy'

const CORE_SCROLLBACK = 5000

export interface Banner { text: string, btn: string, fn: () => void }

// `fill`: side-by-side cell, the terminal takes the whole cell instead of the
// reading column of a pane opened alone.
export function createTerminal(paneId: string, opts: { setBanner: (b: Banner | null) => void, hasBanner: () => boolean, fill?: () => boolean, input?: () => boolean }) {
  let term: Terminal | null = null
  let fit: FitAddon | null = null
  let webgl: WebglAddon | null = null
  let el: HTMLElement | null = null
  let tws: WebSocket | null = null
  let twsRetry = 0
  let twsTimer: ReturnType<typeof setTimeout> | undefined
  let twsIntent = false
  let lastSize = { cols: 0, rows: 0 }
  let disposed = false
  // xterm is being downloaded: what is asked meanwhile is done once it is there.
  let mountSeq = 0
  let mounting = false
  let takeoverQueued = false
  let focusQueued = false
  const loading = ref(false)
  const kbdOn = ref(false)
  const scrollInputVersion = ref(0)
  // Resizes and viewport changes invalidate a gesture's coordinates but must
  // not cancel it — the finger still owns its touch.
  const scrollGeometryVersion = ref(0)
  // Count frames the core stream finished writing through xterm; the smooth
  // gesture path tracks them.
  const frameTick = ref(0)
  const virtualModifiers = ref<VirtualModifier[]>([])
  const lastVirtualChord = ref('')
  const composition = createCompositionTracker()
  const toggleModifier = (key: VirtualModifier) => { virtualModifiers.value = toggleVirtualModifier(virtualModifiers.value, key) }
  const clearVirtualModifiers = () => { virtualModifiers.value = [] }
  const selectionHint = useTerminalSelectionHint()
  let unbindSelection: (() => void) | null = null
  let unbindPaste: (() => void) | null = null
  let unbindOsc52: (() => void) | null = null
  let unbindFonts: (() => void) | null = null
  let links: TerminalLinks | null = null
  let mouse: ReturnType<typeof bindTerminalMouse> | null = null
  let mouseSupported = false
  let coreStream = false
  // herdr-core: whether this viewer's size is the terminal's (see coreTerm.ts).
  let coreControl = true
  let sizeBanner: Banner | null = null
  // Asked before the stream was attached (composer focused on arrival): sent once it is.
  let controlPending = false
  function takeControl() {
    if (coreStream && sendTerm({ type: 'take.control' })) controlPending = false
    else controlPending = true
  }
  // Watching a terminal taller than this screen: shift it so the cursor row,
  // where the newest output is, stays in view.
  function followCursor() {
    const screen = term?.element?.querySelector('.xterm-screen') as HTMLElement | null
    if (!term || !screen || !el) return
    const shown = el.clientHeight - (screen.offsetTop || 0)
    const rowPx = screen.offsetHeight / term.rows
    const over = coreStream && !coreControl ? (term.buffer.active.cursorY + 1) * rowPx - shown : 0
    // Scrolled back into retained history the lift releases toward the screen
    // top as viewportY falls, so the oldest row can reach the clipped host —
    // at the live tail (viewportY === baseY) it is the usual cursor follow.
    const buf = term.buffer.active
    const cap = buf.viewportY < buf.baseY ? buf.viewportY * rowPx : Infinity
    const lift = Math.min(Math.max(over, 0), cap)
    screen.style.transform = lift > 0 ? `translateY(${-Math.ceil(lift)}px)` : ''
  }
  function offerFit() {
    followCursor()
    const fits = !term || !fit || (() => {
      const p = proposeTerminalSize(term!)
      return !p || (p.cols === term!.cols && p.rows === term!.rows)
    })()
    if (!coreStream || coreControl || fits) {
      if (sizeBanner) { sizeBanner = null; opts.setBanner(null) }
      return
    }
    if (sizeBanner || opts.hasBanner()) return
    sizeBanner = {
      text: tl('Shown at the size of another screen.', 'Affiché à la taille d’un autre écran.'),
      btn: tl('Fit to this screen', 'Adapter à cet écran'),
      fn: () => { sizeBanner = null; opts.setBanner(null); takeControl() },
    }
    opts.setBanner(sizeBanner)
  }

  const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

  // Resolves true once the terminal is in `host`, false if it was disposed (or
  // xterm could not be downloaded: a banner then offers to retry) meanwhile.
  async function mount(host: HTMLElement): Promise<boolean> {
    el = host
    // Clear before xterm handles paste, including a one-character paste.
    host.addEventListener('paste', clearVirtualModifiers, true)
    disposed = false
    twsRetry = 0
    const seq = ++mountSeq
    mounting = true
    loading.value = true
    const renderer = terminalRenderer.value
    let xterm: Awaited<ReturnType<typeof loadXterm>>
    let gl: Awaited<ReturnType<typeof loadWebgl>> | null
    try {
      // Both at once: the WebGL renderer is in place before the first fit, as before.
      [xterm, gl] = await Promise.all([loadXterm(), renderer === 'webgl' ? loadWebgl().catch(() => null) : null])
    } catch {
      // A deployment may have removed this version's xterm files (not
      // precached, shared/precache.ts): move to the new version.
      void reloadIfNewBuild()
      if (seq !== mountSeq || disposed) return false
      mounting = false
      loading.value = false
      opts.setBanner({
        text: tl('The terminal could not be loaded.', 'Le terminal n’a pas pu être chargé.'),
        btn: t('Retry'),
        fn: () => {
          opts.setBanner(null)
          if (host.isConnected) void mount(host).then((ok) => { if (ok && !opts.hasBanner()) connect(false) })
        },
      })
      return false
    }
    if (seq !== mountSeq || disposed) return false
    mounting = false
    loading.value = false
    term = new xterm.Terminal({
      fontFamily: TERM_FONT,
      fontSize: fontSize.value,
      // Line height 1: block characters (Claude Code logo) and
      // box-drawing lines must touch from one line to the next.
      lineHeight: 1,
      scrollback: 0, // raised to CORE_SCROLLBACK once the core stream attaches
      cursorBlink: false,
      allowProposedApi: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      // Palette of the app theme (Settings → Theme), updated live.
      theme: terminalTheme.value,
    })
    fit = new xterm.FitAddon()
    term.loadAddon(fit)
    term.open(host)
    mouse = bindTerminalMouse(term, () => mouseSupported && opts.input?.() !== false, event => sendTerm(event))
    // Selection of the visible text, copied on release or with ⌘C.
    unbindSelection = bindTerminalSelection(term, () => toast(t('Copied')))
    // OSC 8 hyperlinks and http(s) URLs, opened in a new tab.
    links = bindTerminalLinks(term, t)
    // Pasted image: its path on the agent's machine, pasted through Herdr,
    // which the agent attaches as an image.
    unbindPaste = bindTerminalImagePaste(host, {
      upload: async f => (await uploadPhoto(paneId, f)).path,
      paste: text => sendTerm({ type: 'paste', text }),
      report: message => toast(message, true),
      enabled: () => opts.input?.() !== false,
    })
    // OSC 52: what the agent copies lands in this device's clipboard. Refused
    // without a gesture (iOS Safari): offered again on a tap.
    unbindOsc52 = bindTerminalOsc52(term, {
      enabled: () => agentClipboard.value,
      write: text => copyAgentText(text, navigator.clipboard, {
        copied: () => toast(t('The agent copied text')),
        refused: refused => toastAction(t('The agent copied text — tap to copy'), t('Copy'), () => {
          copyAgentText(refused, navigator.clipboard, { copied: () => toast(t('Copied')), refused: () => toast(t('Copy failed'), true) })
        }),
      }),
      tooLarge: bytes => toast(tl(
        `Agent copy ignored: ${fmtBytes(bytes)} (limit ${fmtBytes(OSC52_MAX_BYTES)})`,
        `Copie de l’agent ignorée : ${fmtBytes(bytes)} (limite ${fmtBytes(OSC52_MAX_BYTES)})`,
      )),
    })
    // The device's choice may change while the terminal stays mounted (and
    // while xterm was loading: then the add-on is fetched now).
    if (terminalRenderer.value === renderer && (renderer !== 'webgl' || gl)) applyRenderer(renderer, gl?.WebglAddon ?? null)
    else void setRenderer(terminalRenderer.value)
    // JetBrains Mono (bundled): once loaded, xterm re-measures its cells.
    const t0 = term
    Promise.all([
      document.fonts?.load(`${fontSize.value}px "JetBrains Mono Variable"`),
      document.fonts?.load(`${fontSize.value}px "Wherdr Symbols"`, '─▀█⎿⏵⏺✻✳'),
    ]).then(() => {
      if (disposed || term !== t0) return
      t0.options.fontFamily = TERM_FONT
      fitNow(true)
      t0.refresh(0, t0.rows - 1)
    }).catch(() => {})
    // Nerd Font icons load on first use (unicode-range): the WebGL atlas
    // may already hold empty boxes for them, redraw once the face arrives.
    unbindFonts = onFontsLoaded(() => {
      if (disposed || term !== t0) return
      t0.clearTextureAtlas()
      t0.refresh(0, t0.rows - 1)
    })
    const ta = term.textarea
    if (ta) {
      ta.setAttribute('autocorrect', 'off')
      ta.setAttribute('autocapitalize', 'off')
      ta.setAttribute('spellcheck', 'false')
      ta.addEventListener('blur', () => { kbdOn.value = false })
      ta.addEventListener('focus', () => { kbdOn.value = true })
      ta.addEventListener('compositionstart', composition.start)
      ta.addEventListener('compositionend', () => {
        const gen = composition.end()
        // xterm's CompositionHelper reads the textarea on a 0 ms timer armed
        // by its own compositionend listener (attached at open, before this
        // one), so a real commit always reaches onData before this settle
        // runs; only a cancelled composition crosses the boundary still
        // pending. compositionend.data is unreliable on Chromium: the
        // ordering, not the event data, decides what was committed.
        setTimeout(() => composition.settle(gen), 0)
      })
    }
    // Capture on the terminal's element runs before xterm's own keydown
    // listener on the textarea, so the stale flag is dropped before xterm
    // emits the keystroke's data (cancelled IME, then Alt + ←).
    term.element?.addEventListener('keydown', composition.keydown, true)
    // Wheel: xterm must not see it (it would send ↑/↓ to the agent, see
    // utils/terminalWheel.ts); TerminalView scrolls the local viewport instead.
    term.attachCustomWheelEventHandler(() => false)
    // Shift+Enter as a named key; Ctrl+V (outside Apple) and F12 left to the browser.
    bindTerminalKeys(term, key => sendVirtualKey(key))
    term.onData(d => {
      if (opts.input?.() === false) return
      // A programmatic blur is bookkeeping, not input: with focus reporting
      // (DECSET1004) xterm emits ESC[O through onData. Swallow only the
      // sequence this synchronous blur produced — a scroll drag, a keyboard
      // dismissal or copy entry must not send bytes or seize a watching
      // lease, while typed input and real focus events keep flowing.
      if (swallowFocusOut && d === '\x1b[O') return
      // IME-committed text is data, not a keystroke: a composed ASCII
      // character must not spend an armed modifier as a shortcut.
      if (composition.active || composition.takeEnded()) {
        clearVirtualModifiers()
        sendTerm({ type: 'terminal.input', text: d })
        return
      }
      if (virtualModifiers.value.length) {
        const action = virtualInputAction(d)
        if (action.kind === 'key') { void sendVirtualKey(action.key); return }
        // Unsupported text keeps its bytes and the chord does not apply —
        // say so instead of silently dropping the armed modifiers. A paste
        // is quiet.
        if (action.kind === 'blocked') toast(tl('Chord not applied — text sent as typed', 'Accord non appliqué — texte envoyé tel quel'), true)
        clearVirtualModifiers()
      }
      sendTerm({ type: 'terminal.input', text: d })
    })
    term.onBinary((d) => {
      if (opts.input?.() === false) return
      const bytes = Uint8Array.from(d, c => c.charCodeAt(0) & 0xff)
      sendTerm({ type: 'terminal.input', bytes: bytesToB64(bytes) })
    })
    // Any viewport move re-derives the follow transform so a scrolled-back
    // viewer can reach the top rows: onScroll covers programmatic scrolls,
    // and the viewport's own scroll event covers the native scrollbar (xterm
    // suppresses onScroll for changes it originates there). The viewport dies
    // with term.dispose() — no unbind needed.
    term.onScroll(() => followCursor())
    term.element?.querySelector('.xterm-viewport')?.addEventListener('scroll', () => followCursor())
    if (focusQueued) focus()
    return true
  }

  const probe = createSocketProbe(() => tws)
  let handshake: ReturnType<typeof setTimeout> | undefined
  watch(socketWake, () => {
    if (document.hidden || !twsIntent || disposed || opts.hasBanner()) return
    if (!isConnected()) connect(false)
    else void probe.recover(() => {
      if (!disposed && twsIntent && !document.hidden && !opts.hasBanner()) connect(false)
    })
  })

  function sendTerm(obj: unknown): boolean {
    const type = (obj as { type?: string })?.type
    // Paste goes through the input gate like every user action: an image
    // upload completing while the copy surface is open must not reach the agent.
    if (type === 'paste' && opts.input?.() === false) return false
    if (type === 'paste') clearVirtualModifiers()
    // Typed or pasted bytes change the screen a gesture measured — invalid
    // in every scroll mode, locally without any remote cancel.
    if (['terminal.input', 'paste'].includes(type || '')) scrollInputVersion.value++
    if (tws && tws.readyState === 1) {
      tws.send(JSON.stringify(obj))
      return true
    }
    return false
  }

  // Logical keys (esc, up, shift+tab…), encoded by Herdr according to the terminal
  // mode: through the WebSocket if it is open, otherwise through the API.
  async function sendKeys(keys: string[]) {
    if (opts.input?.() === false) return
    scrollInputVersion.value++
    if (sendTerm({ type: 'keys', keys })) return
    try {
      await api('/api/input', { pane_id: paneId, keys })
      haptic()
    } catch (err) { toast((err as Error).message, true) }
  }

  async function sendVirtualKey(key: string) {
    if (opts.input?.() === false) return
    const chord = virtualChord(key, virtualModifiers.value)
    clearVirtualModifiers()
    lastVirtualChord.value = displayVirtualChord(chord)
    const bytes = virtualNavigationBytes(chord)
    if (bytes) {
      if (!sendTerm({ type: 'terminal.input', text: bytes })) await sendKeys(virtualNavigationKeys(chord, useRuntimeConfig().public.core === true))
      return
    }
    await sendKeys([chord])
  }

  function fitNow(send: boolean) {
    if (!term || !fit || !el || !el.parentElement) return
    // Measured on the parent of .xterm (#term), not .xterm itself (as FitAddon does).
    // On the phone, the inset of #term already defines its width.
    const desktop = matchMedia(DESK_QUERY).matches && !opts.fill?.()
    el.style.width = desktop ? `${terminalPixelWidth(el.parentElement.clientWidth, contentWidth.value)}px` : ''
    const p = proposeTerminalSize(term)
    if (!p || !p.cols || !p.rows) return
    const d = { cols: p.cols, rows: p.rows }
    if (!coreStream && (d.cols !== term.cols || d.rows !== term.rows)) term.resize(d.cols, d.rows)
    if (send && (d.cols !== lastSize.cols || d.rows !== lastSize.rows)) {
      if (sendTerm({ type: 'terminal.resize', cols: d.cols, rows: d.rows })) lastSize = { cols: d.cols, rows: d.rows }
    }
    if (coreStream) offerFit()
  }

  // Theme change while the terminal is shown.
  watch(terminalTheme, (th) => { if (term) term.options.theme = th })
  // The preference changes the width in pixels, then FitAddon re-measures.
  watch(contentWidth, () => nextTick(() => fitNow(true)))

  // The WebGL add-on is downloaded the first time it is chosen; until then (or
  // if that fails) xterm keeps the HTML renderer it starts with.
  let rendererSeq = 0
  async function setRenderer(renderer: 'webgl' | 'html') {
    if (!term) return
    const seq = ++rendererSeq
    const current = term
    let Webgl: typeof WebglAddon | null = null
    if (renderer === 'webgl') {
      try { Webgl = (await loadWebgl()).WebglAddon }
      catch { /* offline: HTML renderer */ }
      if (seq !== rendererSeq || term !== current) return
    }
    applyRenderer(renderer, Webgl)
  }
  function applyRenderer(renderer: 'webgl' | 'html', Webgl: typeof WebglAddon | null) {
    if (!term) return
    rendererSeq++
    if (webgl) {
      const old = webgl
      webgl = null
      old.dispose()
    }
    if (renderer === 'webgl') {
      let addon: WebglAddon | null = null
      try {
        if (!Webgl) throw new Error('WebGL add-on not loaded')
        addon = new Webgl()
        const next = addon
        addon.onContextLoss(() => {
          if (webgl !== next) return
          webgl = null
          next.dispose()
          reportTerminalRenderer('html-fallback')
          fitNow(true)
        })
        term.loadAddon(addon)
        // Backing store at CSS size × devicePixelRatio, whatever the browser reports.
        guardWebglCanvasSize(addon)
        webgl = addon
        reportTerminalRenderer('webgl')
      } catch {
        try { addon?.dispose() } catch { /* addon partially activated */ }
        // WebGL unavailable: xterm keeps the HTML renderer.
        reportTerminalRenderer('html-fallback')
      }
    } else {
      reportTerminalRenderer('html')
    }
    // The cell size may change with the renderer. The wheel and
    // the pane size stay handled by fitNow / TerminalView.
    fitNow(true)
  }
  watch(terminalRenderer, r => void setRenderer(r))

  function setFontSize(n: number) {
    if (!term) return
    term.options.fontSize = n
    fitNow(true)
  }

  function connect(takeover: boolean) {
    if (disposed) return
    // Before xterm is there: the view connects once mounted; a take-over asked
    // meanwhile is kept for that connection.
    if (!term) { if (mounting && takeover) takeoverQueued = true; return }
    if (takeoverQueued) { takeover = true; takeoverQueued = false }
    clearTimeout(twsTimer)
    clearTimeout(handshake)
    probe.cancel()
    if (tws) {
      tws.onclose = null
      try { tws.close(1000) }
      catch { /* already closed */ }
    }
    fitNow(false)
    const q = new URLSearchParams({ pane: paneId, cols: String(term.cols), rows: String(term.rows) })
    if (takeover) q.set('takeover', '1')
    mouseSupported = false
    loading.value = true
    twsIntent = true
    let closedReason: string | null = null
    let gotFrame = false
    let lastErr = ''
    scrollInputVersion.value++
    const ws = new WebSocket(`${wsBase()}/ws/term?${q}`)
    tws = ws
    // A CONNECTING socket fires nothing: if the handshake hangs (network not
    // really back yet) nothing retries -- close it on a deadline so onclose
    // schedules the next attempt.
    handshake = setTimeout(() => {
      if (tws === ws && ws.readyState === 0) { try { ws.close() } catch { /* ignore */ } }
    }, 6000)
    ws.onopen = () => {
      if (tws !== ws) return
      clearTimeout(handshake)
      if (term) lastSize = { cols: term.cols, rows: term.rows }
      ws.send(JSON.stringify({ type: 'visibility', visible: !document.hidden }))
    }
    ws.onmessage = (e) => {
      if (tws !== ws) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let m: any
      try { m = JSON.parse(e.data) }
      catch { return }
      if (m.type === 'web.capabilities') {
        mouseSupported = m.mouse === true
        coreStream = m.core === true
        if (term) term.options.scrollback = coreStream ? CORE_SCROLLBACK : 0
      } else if (m.type === 'terminal.frame') {
        if (!gotFrame) {
          gotFrame = true
          twsRetry = 0
        }
        loading.value = false
        if (!term) return
        const current = term
        const credit = coreStream && Number.isInteger(m.credit) && m.credit > 0 ? m.credit : 0
        // Size and reset apply in stream order (see utils/terminalFrame.ts).
        // Core repaints the screen and its history on each attach.
        // A full repaint replaces the screen the gesture measured — input
        // version kills it. A resize only invalidates its coordinates.
        if (coreStream && m.full === true) scrollInputVersion.value++
        writeTerminalFrame(current, { width: m.width, height: m.height, reset: coreStream && m.full === true, bytes: b64ToBytes(m.bytes || '') }, {
          resized: () => {
            if (term !== current) return
            scrollGeometryVersion.value++
            if (coreStream) offerFit()
          },
          written: () => {
            if (credit && tws === ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'credit', bytes: credit }))
            if (coreStream && !coreControl) followCursor()
            selectionHint.refresh(current, mouseSupported)
            if (smoothTouchScrolling.value) frameTick.value++
          },
        })
      } else if (m.type === 'terminal.control') {
        coreControl = m.on === true
        if (controlPending && !coreControl) takeControl()
        else controlPending = false
        offerFit()
      } else if (m.type === 'pong') {
        probe.pong(ws)
      } else if (m.type === 'terminal.closed') {
        closedReason = terminalClosedText(m)
      } else if (m.type === 'herdr.stderr') {
        if (!/^run 'herdr --help'/.test(m.message)) lastErr = m.message
      } else if (m.type === 'web.error') {
        toast(m.message, true)
      }
    }
    ws.onclose = () => {
      if (tws !== ws) return
      scrollInputVersion.value++
      clearTimeout(handshake)
      tws = null
      mouseSupported = false
      coreStream = false
      coreControl = true
      followCursor()
      if (sizeBanner) { sizeBanner = null; opts.setBanner(null) }
      loading.value = false
      probe.cancel()
      if (!twsIntent || disposed) return
      if (closedReason && /already has an attached client/.test(closedReason)) {
        return opts.setBanner({ text: t('This terminal is already open elsewhere.'), btn: t('Take control'), fn: () => { opts.setBanner(null); connect(true) } })
      }
      if (closedReason && /taken over/.test(closedReason)) {
        return opts.setBanner({ text: t('Another client took control.'), btn: t('Take back control'), fn: () => { opts.setBanner(null); connect(true) } })
      }
      if (!currentPane.value && herdrState.value.ok) return // pane closed: the banner is already there
      if (document.hidden) return // we will reconnect on return
      // Repeated failures without a single frame: we stop and show the error
      // rather than loop -- but only for a real reason (the server closed it
      // or reported an error). A transport that never connects deserves an
      // open-ended retry while the page is visible: the tunnel just is not
      // back yet.
      if (!gotFrame && twsRetry >= 3 && (lastErr || closedReason)) {
        twsRetry = 0
        const why = lastErr || closedReason
        return opts.setBanner({ text: terminalUnavailableText(why), btn: t('Retry'), fn: () => { opts.setBanner(null); connect(false) } })
      }
      twsTimer = setTimeout(() => connect(false), Math.min(6000, 400 * 2 ** twsRetry++))
    }
  }

  function disconnect() {
    clearVirtualModifiers()
    scrollInputVersion.value++
    mouseSupported = false
    twsIntent = false
    clearTimeout(twsTimer)
    clearTimeout(handshake)
    probe.cancel()
    if (tws) {
      const ws = tws
      tws = null
      try { ws.close(1000) }
      catch { /* already closed */ }
    }
  }
  const isConnected = () => Boolean(tws && tws.readyState <= 1)

  function reset() { term?.reset() }
  function focus() {
    focusQueued = !term && mounting
    term?.focus()
    kbdOn.value = true
  }
  // Set only around the synchronous textarea blur: the ESC[O that DECSET1004
  // reporting emits through onData for it is swallowed there.
  let swallowFocusOut = false
  function blur() {
    focusQueued = false
    swallowFocusOut = true
    try { term?.textarea?.blur() }
    finally { swallowFocusOut = false }
  }
  // Tap on the touch layer: opens the link under the finger, if any.
  const tapLink = (x: number, y: number) => links?.tap(x, y) ?? false
  // The phone copy layer's frozen screen: refused while an IME composition or
  // its deferred commit may still be in flight — entering copy must never
  // disturb the candidate window or drop the pending text. `pending` settles
  // one finalize tick after compositionend; `ended` can linger set after a
  // cancelled composition until the next keystroke and must not block copy.
  const captureScreen = (): TerminalCopySnapshot | null => {
    if (!term || composition.active || composition.pending) return null
    return captureTerminalScreen(term)
  }
  // An active composition or a deferred commit that may still land: a
  // programmatic blur could disturb the candidate window or drop the text.
  const imeBusy = () => composition.active || composition.pending
  const hasFocus = () => Boolean(term && document.activeElement === term.textarea)
  const rowHeight = () => {
    // The rendered grid's own row height: a watching terminal can be taller
    // than the host (clipped + translateY'd), so host height must never
    // divide the grid's rows. Fall back to the host, then to a safe row.
    const screen = el?.querySelector('.xterm-screen') as HTMLElement | null
    if (term?.rows && screen?.clientHeight) return screen.clientHeight / term.rows
    return term?.rows && el?.clientHeight ? el.clientHeight / term.rows : 16
  }
  const pageRows = () => term?.rows || 24
  // A tap on the cursor's own row asks to type at the field; a tap anywhere
  // else only acts on the pane (stop inertia, open a link).
  function tapOnCursor(x: number, y: number): boolean {
    const screen = term?.element?.querySelector('.xterm-screen') as HTMLElement | null
    const rect = screen?.getBoundingClientRect()
    const cell = rect && term ? terminalCell(x, y, rect, term.cols, term.rows) : null
    if (!cell || !term) return false
    const buffer = term.buffer.active
    return cell.row + buffer.viewportY === buffer.cursorY + buffer.baseY
  }
  // Scrolling is local: the attach delivered the scrollback and xterm owns
  // the viewport. Positive lines look back into history.
  function scroll(lines: number): boolean {
    if (!term) return false
    term.scrollLines(-lines)
    return true
  }
  const stopSmoothWatch = watch(smoothTouchScrolling, () => {
    scrollInputVersion.value++
  }, { flush: 'sync' })
  // Android Back can hide the IME while the textarea keeps its focus; the
  // next touch would reopen the keyboard instantly. On a coarse pointer the
  // IME closing releases the terminal focus it was held for — never while a
  // composition or a deferred commit is still in flight.
  const stopKeyboardWatch = watch(kbOpen, (open, wasOpen) => {
    if (wasOpen && !open && matchMedia('(hover: none) and (pointer: coarse)').matches && hasFocus() && !imeBusy()) blur()
  })

  function setVisible(visible: boolean) {
    if (!visible) scrollInputVersion.value++
    sendTerm({ type: 'visibility', visible })
    // Another client may have resized the pane while we were away.
    if (visible) nextTick(() => fitNow(true))
  }

  function dispose() {
    el?.removeEventListener('paste', clearVirtualModifiers, true)
    disposed = true
    if (mounting) loading.value = false
    mounting = false
    takeoverQueued = false
    focusQueued = false
    stopSmoothWatch()
    stopKeyboardWatch()
    disconnect()
    unbindSelection?.()
    unbindPaste?.()
    unbindOsc52?.()
    unbindOsc52 = null
    unbindFonts?.()
    unbindFonts = null
    unbindSelection = null
    unbindPaste = null
    mouse?.dispose()
    mouse = null
    links?.dispose()
    links = null
    webgl = null // term.dispose() destroys its addons
    term?.dispose()
    term = null
  }

  return {
    mount, connect, disconnect, takeControl, isConnected, sendTerm, sendKeys, fitNow, setFontSize,
    reset, scroll, focus, blur, tapLink, tapMouse: (x: number, y: number) => mouse?.tap(x, y), tapOnCursor, hasFocus, rowHeight, pageRows, setVisible, dispose, loading, kbdOn, captureScreen, imeBusy,
    hasBanner: opts.hasBanner, selectionHint,
    scrollInputVersion, scrollGeometryVersion, frameTick,
    virtualModifiers, lastVirtualChord, toggleModifier, toggleVirtualModifier: toggleModifier, clearVirtualModifiers, sendVirtualKey,
  }
}

export type TerminalCtl = ReturnType<typeof createTerminal>
