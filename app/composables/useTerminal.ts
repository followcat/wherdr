// Terminal of a pane: xterm.js connected to /ws/term (Herdr's ANSI frames).
// Herdr keeps the history: no local scrollback, scrolling is
// requested from the server (terminal.scroll).
import { createSocketProbe } from '~/utils/socketProbe'
import { DESK_QUERY } from '~/utils/layoutMode'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { terminalPixelWidth } from '~/utils/terminalSize'
import { bindTerminalSelection } from '~/utils/terminalSelection'
import { bindTerminalLinks, type TerminalLinks } from '~/utils/terminalLinks'
import { bindTerminalKeys } from '~/utils/terminalKeys'
import { bindTerminalImagePaste } from '~/utils/terminalPaste'
import { fmtBytes } from '~/utils/bytes'
import { OSC52_MAX_BYTES, bindTerminalOsc52, copyAgentText } from '~/utils/terminalOsc52'
import { uploadPhoto } from '~/utils/photoUpload'
import { terminalClosedText, terminalUnavailableText } from '~/utils/terminalClosed'
import { bindTerminalMouse, terminalCell } from '~/utils/terminalMouse'
import { createTranscriptCache } from '~/utils/transcriptCache'
import { bufferLineToHtml } from '~/utils/bufferLineHtml'
import { TERM_FONT, onFontsLoaded } from '~/utils/terminalFont'
import { displayVirtualChord, toggleVirtualModifier, virtualChord, virtualInputAction, virtualNavigationBytes, type VirtualModifier } from '~/utils/virtualKeys'

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
  const loading = ref(false)
  const kbdOn = ref(false)
  const scrollInputVersion = ref(0)
  // Count parsed frames separately from the scroll rows they acknowledge.
  const frameTick = ref(0)
  // Cumulative signed rows acknowledged after xterm parses the next frame.
  const scrollAck = ref(0)
  let touchEpoch = 0
  const virtualModifiers = ref<VirtualModifier[]>([])
  const lastVirtualChord = ref('')
  const toggleModifier = (key: VirtualModifier) => { virtualModifiers.value = toggleVirtualModifier(virtualModifiers.value, key) }
  const clearVirtualModifiers = () => { virtualModifiers.value = []; lastVirtualChord.value = '' }
  const selectionHint = useTerminalSelectionHint()
  let unbindSelection: (() => void) | null = null
  let unbindPaste: (() => void) | null = null
  let unbindOsc52: (() => void) | null = null
  let unbindFonts: (() => void) | null = null
  let links: TerminalLinks | null = null
  let mouse: ReturnType<typeof bindTerminalMouse> | null = null
  let mouseSupported = false
  // Reactive copy of the pane's mouse capability for the touch layer. The
  // wire stream cannot be trusted for the pane's live mode -- herdr replays
  // screens without the original mode-switch sequences, and inline TUIs
  // redraw on the normal buffer -- so the capability advertised at attach
  // stays the only reliable signal.
  const mouseMode = ref(false)
  // Local scrollback overlay state (scrollback.read / scrollback.chunk).
  const scrollback = ref('')
  const scrollbackVersion = ref(0)
  // Painted-row cache feeding the touch preview's revealed edge.
  const transcript = createTranscriptCache()

  const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

  function mount(host: HTMLElement) {
    el = host
    disposed = false
    twsRetry = 0
    transcript.reset()
    term = new Terminal({
      fontFamily: TERM_FONT,
      fontSize: fontSize.value,
      // Line height 1: block characters (Claude Code logo) and
      // box-drawing lines must touch from one line to the next.
      lineHeight: 1,
      scrollback: 0, // Herdr keeps the history; scrolling happens on the server
      cursorBlink: false,
      allowProposedApi: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      // Palette of the app theme (Settings → Theme), updated live.
      theme: terminalTheme.value,
    })
    fit = new FitAddon()
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
    // The device's choice may change while the terminal stays mounted.
    setRenderer(terminalRenderer.value)
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
    }
    // Wheel: xterm does nothing with it (it would send ↑/↓ to the agent, see
    // utils/terminalWheel.ts); TerminalView converts it to terminal.scroll.
    term.attachCustomWheelEventHandler(() => false)
    // Shift+Enter as a named key; Ctrl+V (outside Apple) and F12 left to the browser.
    bindTerminalKeys(term, key => sendVirtualKey(key))
    term.onData(d => {
      if (opts.input?.() === false) return
      if (virtualModifiers.value.length) {
        const action = virtualInputAction(d)
        if (action.kind === 'key') { void sendVirtualKey(action.key); return }
        if (action.kind === 'blocked') { toast('组合键请选择面板按键，或切换英文输入单个字母', true); return }
        clearVirtualModifiers() // A paste stays text, never a series of shortcuts.
      }
      sendTerm({ type: 'terminal.input', text: d })
    })
    term.onBinary((d) => {
      if (opts.input?.() === false) return
      const bytes = Uint8Array.from(d, c => c.charCodeAt(0) & 0xff)
      sendTerm({ type: 'terminal.input', bytes: bytesToB64(bytes) })
    })
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
    if (smoothTouchScrolling.value && ['terminal.input', 'paste'].includes((obj as { type?: string })?.type || '')) {
      scrollInputVersion.value++
      cancelTouchScroll()
    }
    if ((obj as { type?: string })?.type === 'paste') clearVirtualModifiers()
    if (tws && tws.readyState === 1) {
      tws.send(JSON.stringify(obj))
      return true
    }
    return false
  }

  // Logical keys (esc, up, shift+tab…), encoded by Herdr according to the terminal
  // mode: through the WebSocket if it is open, otherwise through the API.
  async function sendKeys(keys: string[]) {
    if (smoothTouchScrolling.value) { scrollInputVersion.value++; cancelTouchScroll() }
    if (sendTerm({ type: 'keys', keys })) return
    try {
      await api('/api/input', { pane_id: paneId, keys })
      haptic()
    } catch (err) { toast((err as Error).message, true) }
  }

  async function sendVirtualKey(key: string) {
    if (opts.input?.() === false) return
    const chord = virtualChord(key, virtualModifiers.value)
    virtualModifiers.value = []
    lastVirtualChord.value = displayVirtualChord(chord)
    const navigation = virtualNavigationBytes(chord)
    if (navigation) {
      if (!sendTerm({ type: 'terminal.input', text: navigation })) toast('终端正在连接，请连接后重试', true)
      return
    }
    await sendKeys([chord])
  }

  function fitNow(send: boolean) {
    if (!term || !fit || !el || !el.parentElement) return
    // FitAddon measures the parent of .xterm (#term), not .xterm itself.
    // On the phone, the inset of #term already defines its width.
    const desktop = matchMedia(DESK_QUERY).matches && !opts.fill?.()
    el.style.width = desktop ? `${terminalPixelWidth(el.parentElement.clientWidth, contentWidth.value)}px` : ''
    const p = fit.proposeDimensions()
    if (!p || !p.cols || !p.rows) return
    const d = { cols: p.cols, rows: p.rows }
    if (d.cols !== term.cols || d.rows !== term.rows) term.resize(d.cols, d.rows)
    if (send && (d.cols !== lastSize.cols || d.rows !== lastSize.rows)) {
      if (sendTerm({ type: 'terminal.resize', cols: d.cols, rows: d.rows })) lastSize = { cols: d.cols, rows: d.rows }
    }
  }

  // Theme change while the terminal is shown.
  watch(terminalTheme, (th) => { if (term) term.options.theme = th })
  // The preference changes the width in pixels, then FitAddon re-measures.
  watch(contentWidth, () => nextTick(() => fitNow(true)))

  function setRenderer(renderer: 'webgl' | 'html') {
    if (!term) return
    if (webgl) {
      const old = webgl
      webgl = null
      old.dispose()
    }
    if (renderer === 'webgl') {
      let addon: WebglAddon | null = null
      try {
        addon = new WebglAddon()
        const next = addon
        addon.onContextLoss(() => {
          if (webgl !== next) return
          webgl = null
          next.dispose()
          reportTerminalRenderer('html-fallback')
          fitNow(true)
        })
        term.loadAddon(addon)
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
  watch(terminalRenderer, setRenderer)

  function setFontSize(n: number) {
    if (!term) return
    term.options.fontSize = n
    fitNow(true)
  }

  function connect(takeover: boolean) {
    if (disposed || !term) return
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
    touchEpoch++
    if (smoothTouchScrolling.value) scrollInputVersion.value++
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
        mouseMode.value = mouseSupported
      } else if (m.type === 'terminal.frame') {
        if (!gotFrame) {
          gotFrame = true
          twsRetry = 0
        }
        loading.value = false
        if (!term) return
        if (m.width && m.height && (m.width !== term.cols || m.height !== term.rows)) {
          if (smoothTouchScrolling.value) { scrollInputVersion.value++; cancelTouchScroll() }
          transcript.reset()
          term.resize(m.width, m.height)
        }
        const current = term
        current.write(b64ToBytes(m.bytes || ''), () => {
          selectionHint.refresh(current, mouseSupported)
          if (smoothTouchScrolling.value) {
            // Feed the painted screen to the transcript cache so the touch
            // preview can reveal real rows instead of void.
            const buf = current.buffer?.active
            if (buf) {
              const lines: string[] = [], styled: string[] = []
              const theme = current.options.theme
              for (let i = 0; i < current.rows; i++) {
                const l = buf.getLine(buf.baseY + i)
                lines.push(l?.translateToString(true) ?? '')
                styled.push(l ? bufferLineToHtml(l, theme) : '')
              }
              transcript.frame(lines, styled)
            }
            frameTick.value++
          }
        })
      } else if (m.type === 'scroll.ack') {
        if (smoothTouchScrolling.value && m.epoch === touchEpoch && Number.isFinite(m.lines) && term) {
          // Queue behind the covering frame, including when write's callback
          // ran before the separate ack packet arrived.
          const epoch = touchEpoch
          term.write('', () => { if (epoch === touchEpoch && smoothTouchScrolling.value) scrollAck.value += m.lines })
        }
      } else if (m.type === 'scrollback.chunk') {
        scrollback.value = typeof m.text === 'string' ? m.text : ''
        scrollbackVersion.value++
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
      if (smoothTouchScrolling.value) { scrollInputVersion.value++; touchEpoch++ }
      clearTimeout(handshake)
      tws = null
      mouseSupported = false
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
    if (smoothTouchScrolling.value) { scrollInputVersion.value++; touchEpoch++ }
    clearVirtualModifiers()
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
    term?.focus()
    kbdOn.value = true
  }
  function blur() { term?.textarea?.blur() }
  // Tap on the touch layer: opens the link under the finger, if any.
  const tapLink = (x: number, y: number) => links?.tap(x, y) ?? false
  const hasFocus = () => Boolean(term && document.activeElement === term.textarea)
  const rowHeight = () => {
    if (!smoothTouchScrolling.value) return term && term.rows && el ? el.clientHeight / term.rows : 16
    const screen = el?.querySelector('.xterm-screen') as HTMLElement | null
    return term?.rows && screen?.clientHeight ? screen.clientHeight / term.rows : 16
  }
  const pageRows = () => term?.rows || 24
  // Scrolling requested from Herdr (the history lives there).
  function scroll(lines: number, x?: number, y?: number, modifiers = 0, touch = false, preview = true): boolean {
    if (!smoothTouchScrolling.value || !touch) return sendTerm({ type: 'terminal.scroll', direction: lines > 0 ? 'up' : 'down', lines: Math.abs(lines) })
    const screen = term?.element?.querySelector('.xterm-screen') as HTMLElement | null
    const rect = screen?.getBoundingClientRect()
    const offset = screen?.style.transform ? new DOMMatrixReadOnly(screen.style.transform).m42 : 0
    const fixedRect = rect ? { left: rect.left, top: rect.top - offset, width: rect.width, height: rect.height } : null
    const position = fixedRect && term && x !== undefined && y !== undefined ? terminalCell(x, y, fixedRect, term.cols, term.rows) : null
    return sendTerm({ type: 'terminal.scroll', direction: lines > 0 ? 'up' : 'down', lines: Math.abs(lines), ...position, modifiers, source: 'touch', epoch: touchEpoch, preview })
  }
  function cancelTouchScroll() {
    touchEpoch++
    if (smoothTouchScrolling.value) sendTerm({ type: 'touch.cancel' })
  }
  const stopSmoothWatch = watch(smoothTouchScrolling, (_, wasEnabled) => {
    touchEpoch++
    scrollInputVersion.value++
    if (wasEnabled) sendTerm({ type: 'touch.cancel', disabled: true })
  }, { flush: 'sync' })

  // Local scrollback overlay: ask the server for the pane's recent history
  // (Herdr's recent_unwrapped dump, ANSI-styled).
  function requestScrollback(lines: number, source?: string) { sendTerm({ type: 'scrollback.read', lines, source }) }

  function setVisible(visible: boolean) {
    if (!visible && smoothTouchScrolling.value) { scrollInputVersion.value++; cancelTouchScroll() }
    sendTerm({ type: 'visibility', visible })
    // Another client may have resized the pane while we were away.
    if (visible) nextTick(() => fitNow(true))
  }

  function dispose() {
    disposed = true
    stopSmoothWatch()
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
    mount, connect, disconnect, isConnected, sendTerm, sendKeys, fitNow, setFontSize,
    reset, scroll, focus, blur, tapLink, tapMouse: (x: number, y: number) => mouse?.tap(x, y), hasFocus, rowHeight, pageRows, setVisible, dispose, loading, kbdOn,
    hasBanner: opts.hasBanner, selectionHint,
    cancelTouchScroll, scrollInputVersion, frameTick, scrollAck,
    scrollback, scrollbackVersion, requestScrollback, mouseMode,
    previewExtra: (dir: number) => transcript.available(dir), previewRows: (dir: number, count: number) => transcript.slice(dir, count), resetTranscript: () => transcript.reset(),
    transcriptRange: () => transcript.range(), transcriptAt: (idx: number) => transcript.at(idx), transcriptHas: (idx: number) => transcript.has(idx),
    transcriptWindow: () => ({ top: transcript.windowTop(), rows: transcript.windowRows() }),
    transcriptInject: (idx: number, e: { t: string, h?: string }) => transcript.inject(idx, e),
    termTheme: () => term?.options.theme,
    virtualModifiers, lastVirtualChord, toggleVirtualModifier: toggleModifier, clearVirtualModifiers, sendVirtualKey,
  }
}

export type TerminalCtl = ReturnType<typeof createTerminal>
