// Terminal: relay of `herdr terminal session control`.
// The CLI speaks line-delimited JSON on stdin/stdout:
//   output: {"type":"terminal.frame","encoding":"ansi","full":bool,"width","height","seq","bytes":<b64>}
//            {"type":"terminal.closed","reason":…}
//   input: terminal.input {text|bytes}, terminal.resize {cols,rows},
//            terminal.scroll {direction:up|down,lines}, terminal.mouse, terminal.release
// Only one "attached" client per terminal: without --takeover, the connection is
// refused if someone else already is; with it, the other one is detached.
// Pane of a remote machine: the same CLI, launched on that machine over the
// multiplexed SSH connection (stdin/stdout relayed as is).
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { DATA_DIR, PANE_RE, log } from './env'
import { herdr } from './herdr'
import { getState, termSessions, type TermView } from './state'
import { cleanTerminalMouse, hasTerminalMouse } from '../../shared/herdrFeatures'
import { machineOfPane, runHerdrCli } from './machines'
import { type PaneHold, type PaneSize, cleanSavedSizes, createPaneSizes, parseSttySize } from './paneSizes'
import { splitId } from '../../shared/ids'
import { createScrollThrottle } from './scrollThrottle'
import { terminalScrollPosition } from './scrollPosition'
import { createTouchScrollPacer } from './touchScrollPacer'
import { fmt } from '../../shared/message'

export const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

// What the relay needs from a WebSocket (crossws or other).
export interface WsLike {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  isOpen: () => boolean
}

export interface TermSession {
  onMessage: (raw: string) => void
  // `clean`: closed on purpose by the client (not a dropped connection).
  onClose: (clean?: boolean) => void
}

// ---------------------------------------------------------------- pane size
// Size of the PTY behind a shell: Herdr's API only gives the rows.
const TTY_SIZE_SCRIPT = 't=$(ps -o tty= -p "$1" 2>/dev/null | tr -d " "); [ -n "$t" ] && [ -c "/dev/$t" ] && stty size < "/dev/$t"'

function ttySize(pane: string, pid: number): Promise<string> {
  const machine = machineOfPane(pane)
  if (!machine) return Promise.resolve('')
  if (machine.exec) return machine.exec(TTY_SIZE_SCRIPT, [String(pid)], { timeoutMs: 4000 }).then(r => (r.code === 0 ? r.stdout.toString('utf8') : ''), () => '')
  return new Promise(resolve => execFile('sh', ['-c', TTY_SIZE_SCRIPT, 'sh', String(pid)], { timeout: 2000 }, (err, stdout) => resolve(err ? '' : String(stdout))))
}

// Current size of a pane. Exact when the PTY of its shell can be asked (and
// agrees with the rows Herdr reports); otherwise the rows Herdr reports and
// the width of the pane in Herdr's layout, the one Herdr would give it.
export async function readPaneSize(pane: string): Promise<PaneSize | null> {
  const p = (await herdr('pane.get', { pane_id: pane }, 3000).catch(() => null))?.pane
  if (!p) return null
  const terminal = typeof p.terminal_id === 'string' ? { terminal: p.terminal_id as string } : {}
  const rows = Number(p.scroll?.viewport_rows) || 0
  const pid = Number((await herdr('pane.process_info', { pane_id: pane }, 3000).catch(() => null))?.process_info?.shell_pid)
  if (Number.isInteger(pid) && pid > 1) {
    const tty = parseSttySize(await ttySize(pane, pid))
    if (tty && (!rows || tty.rows === rows)) return { ...tty, exact: true, ...terminal }
  }
  const local = splitId(pane).local
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rect = (await herdr('pane.layout', { pane_id: pane }, 3000).catch(() => null))?.layout?.panes?.find((x: any) => x.pane_id === local)?.rect
  const cols = Number(rect?.width) || 0
  if (!rows || !cols) return null
  return { cols, rows, exact: false, ...terminal }
}

const sizesFile = () => path.join(DATA_DIR, 'term-sizes.json')
const delay = (name: string, dflt: number) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

let sizes: ReturnType<typeof createPaneSizes> | null = null
const paneSizes = () => sizes ||= createPaneSizes({
  read: readPaneSize,
  resize: (pane, cols, rows) => resizePane(pane, cols, rows),
  // Longer than the 1.5 s left to a closed control session to go away.
  closeMs: delay('WHERDR_TERM_CLOSE_MS', 2000),
  graceMs: delay('WHERDR_TERM_GRACE_MS', 30000),
  save(held) {
    const file = sizesFile()
    try {
      if (!Object.keys(held).length) return fs.rmSync(file, { force: true })
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(held) + '\n', { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
    } catch (e) { log(`term sizes: ${(e as Error).message}`) }
  },
  log,
})

// Panes left at the phone's size by a wherdr stopped with terminals open.
export function startPaneSizes() {
  let saved: unknown = null
  try { saved = JSON.parse(fs.readFileSync(sizesFile(), 'utf8')) }
  catch { return }
  paneSizes().adopt(cleanSavedSizes(saved, id => PANE_RE.test(id)))
}
export function stopPaneSizes() { sizes?.stop() }

// ---------------------------------------------------------------- relay

export function openTerm(ws: WsLike, url: URL): TermSession | null {
  const pane = url.searchParams.get('pane') || ''
  if (!PANE_RE.test(pane)) {
    ws.close(4400, 'Invalid pane')
    return null
  }
  const machine = machineOfPane(pane)
  if (!machine || !machine.sock()) {
    ws.send(JSON.stringify({ type: 'terminal.closed', reason: machine ? fmt('{machine} is unreachable', { machine: machine.label }) : 'unknown machine', code: machine ? 'unreachable' : 'unknown_machine', machine: machine?.label }))
    ws.close(4503, 'machine unreachable')
    return null
  }
  const cols = clampInt(url.searchParams.get('cols'), 10, 400, 80)
  const rows = clampInt(url.searchParams.get('rows'), 5, 200, 24)
  const args = ['terminal', 'session', 'control', splitId(pane).local, '--cols', String(cols), '--rows', String(rows)]
  if (url.searchParams.get('takeover') === '1') args.push('--takeover')

  const sess: TermView = { pane, visible: true }
  termSessions.add(sess)
  let child: ChildProcessWithoutNullStreams | null = null
  let hold: PaneHold | null = null
  let closed = false
  // Size asked by this terminal, the pane's own once the session is attached
  // (a refused session, terminal open elsewhere, never resizes the pane).
  let size = { cols, rows }
  let attached = false
  let mouse = false
  // What the client sends before the control session is started.
  const early: unknown[] = []

  const toChild = (obj: unknown) => {
    if (!child) {
      if (early.length < 64) early.push(obj)
    } else if (child.stdin.writable) {
      child.stdin.write(JSON.stringify(obj) + '\n')
    }
  }

  function start() {
    const c = machine!.spawnHerdr(args)
    child = c
    log(`term ${pane} opened ${cols}x${rows}${args.includes('--takeover') ? ' (takeover)' : ''}${machine!.local ? '' : ` on ${machine!.label}`}`)

    readline.createInterface({ input: c.stdout }).on('line', (line) => {
      const isFrame = line.includes('"terminal.frame"')
      if (!attached && isFrame) {
        attached = true
        hold?.resized(size.cols, size.rows)
      }
      if (ws.isOpen()) {
        ws.send(line)
        if (isFrame) {
          for (const [epoch, lines] of scrollDelivered)
            ws.send(JSON.stringify({ type: 'scroll.ack', epoch, lines }))
          scrollDelivered.clear()
        }
      } else scrollDelivered.clear()
      if (isFrame) touchScroll?.frame()
    })
    readline.createInterface({ input: c.stderr }).on('line', (line) => {
      log(`term ${pane} stderr: ${line}`)
      if (ws.isOpen()) ws.send(JSON.stringify({ type: 'herdr.stderr', message: line }))
    })
    c.on('error', (e) => {
      if (ws.isOpen()) ws.send(JSON.stringify({ type: 'terminal.closed', reason: `herdr: ${e.message}` }))
      ws.close(4500, 'herdr error')
    })
    c.on('exit', (code) => {
      scroll.dispose()
      touchScroll?.dispose()
      touchMerged.dispose()
      termSessions.delete(sess)
      if (ws.isOpen()) ws.close(4000, `herdr exit ${code}`)
    })
    // No crash if the CLI closes while we write to it.
    c.stdin.on('error', () => {})
    for (const m of early.splice(0)) toChild(m)
  }

  // Scrolls merged and rate-limited (see scrollThrottle.ts).
  // Acknowledge sent rows after relaying the next frame. Herdr exposes no
  // applied viewport delta or causal input sequence, so this is prediction.
  const scrollDelivered = new Map<number, number>()
  type TouchPosition = ReturnType<typeof terminalScrollPosition> & { epoch: number, preview: boolean }
  let touchScroll: ReturnType<typeof createTouchScrollPacer<TouchPosition>> | undefined
  // Preserve the legacy wire contract, and allocate no pacer for default clients.
  const scroll = createScrollThrottle((direction, lines) => toChild({ type: 'terminal.scroll', direction, lines }))
  const pacedTouch = () => touchScroll ||= createTouchScrollPacer<TouchPosition>((direction, lines, position) => {
    if (!position) return
    const { epoch, preview, ...cell } = position
    if (preview) scrollDelivered.set(epoch, (scrollDelivered.get(epoch) || 0) + (direction === 'up' ? lines : -lines))
    toChild({ type: 'terminal.scroll', direction, lines, ...cell })
  })
  // Panes without mouse-report need no per-tick wheel reports: Herdr honors
  // lines:N there, so merge touch drags into one command per repaint instead
  // of one frame per row.
  const touchMerged = createScrollThrottle((direction, lines) => toChild({ type: 'terminal.scroll', direction, lines }), { intervalMs: 30 })
  let scrollbackSeq = 0

  // The pane's size is read before the control session resizes it (see paneSizes.ts).
  paneSizes().hold(pane).then(async (h) => {
    if (closed) return h.release(true)
    hold = h
    const version = await runHerdrCli(machine!, ['--version']).catch(() => null)
    if (closed) return
    const state = getState()
    const serverVersion = state.machines?.find(m => m.key === machine!.key)?.version ?? (machine!.key === '' ? state.version : '')
    mouse = version?.code === 0 && hasTerminalMouse(version.stdout.toString('utf8')) && hasTerminalMouse(serverVersion || '')
    if (ws.isOpen()) ws.send(JSON.stringify({ type: 'web.capabilities', mouse }))
    start()
  })

  return {
    onMessage(raw: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let m: any
      try { m = JSON.parse(raw) }
      catch { return }
      switch (m && m.type) {
        case 'ping': // liveness probe after sleep/backgrounding
          if (ws.isOpen()) ws.send(JSON.stringify({ type: 'pong' }))
          break
        case 'terminal.input':
          touchScroll?.cancel()
          touchMerged.cancel()
          if (typeof m.text === 'string' && m.text.length <= 65536) toChild({ type: 'terminal.input', text: m.text })
          else if (typeof m.bytes === 'string' && m.bytes.length <= 90000) toChild({ type: 'terminal.input', bytes: m.bytes })
          break
        case 'terminal.mouse': {
          touchScroll?.cancel()
          touchMerged.cancel()
          const event = mouse && cleanTerminalMouse(m, size.cols, size.rows)
          if (event) toChild(event)
          break
        }
        case 'terminal.resize': {
          touchScroll?.cancel()
          touchMerged.cancel()
          size = { cols: clampInt(m.cols, 10, 400, cols), rows: clampInt(m.rows, 5, 200, rows) }
          if (attached) hold?.resized(size.cols, size.rows)
          toChild({ type: 'terminal.resize', ...size })
          break
        }
        case 'terminal.scroll':
          if (m.direction === 'up' || m.direction === 'down') {
            if (m.source === 'touch') {
              if (mouse) {
                pacedTouch().push(m.direction, clampInt(m.lines, 1, 500, 3), {
                  ...terminalScrollPosition(m, size.cols, size.rows),
                  epoch: clampInt(m.epoch, 0, Number.MAX_SAFE_INTEGER, 0), preview: m.preview !== false,
                })
              }
              else touchMerged.push(m.direction, clampInt(m.lines, 1, 500, 3))
            }
            else { touchScroll?.cancel(); touchMerged.cancel(); scroll.push(m.direction, clampInt(m.lines, 1, 500, 3)) }
          }
          break
        case 'touch.cancel':
          if (m.disabled === true) { touchScroll?.dispose(); touchScroll = undefined }
          else touchScroll?.cancel()
          touchMerged.cancel()
          scrollDelivered.clear()
          break
        // The client renders scrollback locally in a native scroller, so the
        // terminal itself never leaves the bottom for history browsing.
        case 'scrollback.read': {
          const seq = ++scrollbackSeq
          herdr('pane.read', { pane_id: pane, source: 'recent_unwrapped', lines: clampInt(m.lines, 1, 4000, 800), format: 'ansi' }, 8000)
            .then(r => { if (seq === scrollbackSeq && ws.isOpen()) ws.send(JSON.stringify({ type: 'scrollback.chunk', text: String(r?.read?.text || '') })) })
            .catch(() => { if (seq === scrollbackSeq && ws.isOpen()) ws.send(JSON.stringify({ type: 'scrollback.chunk', text: '' })) })
          break
        }
        case 'keys': // logical keys encoded by Herdr according to the terminal mode
          touchScroll?.cancel()
          touchMerged.cancel()
          if (Array.isArray(m.keys) && m.keys.length <= 32 && m.keys.every((k: unknown) => typeof k === 'string' && k.length <= 24)) {
            herdr('pane.send_input', { pane_id: pane, keys: m.keys }).catch(e =>
              ws.isOpen() && ws.send(JSON.stringify({ type: 'web.error', code: e.code, message: e.message })))
          }
          break
        // Pasted text, as Herdr's pane input: omp receives it as a paste and
        // turns an image path into an image (typed through wherdr's xterm, which
        // never learns the program's bracketed paste mode, it stays text).
        case 'paste':
          touchScroll?.cancel()
          touchMerged.cancel()
          if (typeof m.text === 'string' && m.text && m.text.length <= 65536) {
            herdr('pane.send_input', { pane_id: pane, text: m.text }).catch(e =>
              ws.isOpen() && ws.send(JSON.stringify({ type: 'web.error', code: e.code, message: e.message })))
          }
          break
        case 'visibility':
          sess.visible = Boolean(m.visible)
          if (!sess.visible) { touchScroll?.cancel(); touchMerged.cancel() }
          break
      }
    },
    onClose(clean = false) {
      closed = true
      scroll.dispose()
      touchScroll?.dispose()
      touchMerged.dispose()
      termSessions.delete(sess)
      const c = child
      if (c) {
        // Hand control back cleanly (the pane size goes back to the other clients).
        toChild({ type: 'terminal.release' })
        c.stdin.end()
        setTimeout(() => {
          if (c.exitCode === null) c.kill('SIGTERM')
        }, 1500)
      }
      // No Herdr client to lay the pane out again: its size is given back.
      // A terminal left in the background (locked phone) usually comes back.
      hold?.release(clean && sess.visible)
    },
  }
}

// Sets a pane's size through a short control session: Herdr keeps that size
// once the session is released (until a client resizes it). Refused (false)
// while a client is attached to the terminal (wherdr's terminal open on the
// phone): its size is never taken over.
export function resizePane(pane: string, cols: number, rows: number): Promise<boolean> {
  const machine = machineOfPane(pane)
  if (!machine || !machine.sock()) return Promise.resolve(false)
  const child = machine.spawnHerdr(['terminal', 'session', 'control', splitId(pane).local, '--cols', String(cols), '--rows', String(rows)])
  child.stdin.on('error', () => {})
  const { promise, resolve } = Promise.withResolvers<boolean>()
  let done = false
  const finish = (ok: boolean) => {
    if (done) return
    done = true
    clearTimeout(timer)
    if (child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'terminal.release' }) + '\n')
    child.stdin.end()
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM')
    }, 1500)
    log(`term ${pane} ${ok ? `resized to ${cols}x${rows}` : 'resize refused'}`)
    resolve(ok)
  }
  const timer = setTimeout(() => finish(false), 5000)
  // First frame: attached at the new size. Anything else ("already has an
  // attached client", closed): refused.
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let m: { type?: string } | null = null
    try { m = JSON.parse(line) }
    catch { /* not JSON */ }
    finish(m?.type === 'terminal.frame')
  })
  child.on('error', () => finish(false))
  child.on('exit', () => finish(false))
  return promise
}
