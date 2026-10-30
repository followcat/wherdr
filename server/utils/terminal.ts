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
import { machineOfPane, runHerdrCli, type Machine } from './machines'
import { type PaneHold, type PaneSize, cleanSavedSizes, createPaneSizes, parseSttySize } from './paneSizes'
import { splitId } from '../../shared/ids'
import { createScrollThrottle } from './scrollThrottle'
import { terminalScrollPosition } from './scrollPosition'
import { createTouchScrollPacer } from './touchScrollPacer'
import { createTerminalWriter } from './terminalWriter'
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
  // Independent reads go together: on a remote machine each is a separate
  // SSH round trip, and serializing them cost a whole extra hop.
  const [g, pi] = await Promise.all([
    herdr('pane.get', { pane_id: pane }, 3000).catch(() => null),
    herdr('pane.process_info', { pane_id: pane }, 3000).catch(() => null),
  ])
  const p = g?.pane
  if (!p) return null
  const terminal = typeof p.terminal_id === 'string' ? { terminal: p.terminal_id as string } : {}
  const rows = Number(p.scroll?.viewport_rows) || 0
  const pid = Number(pi?.process_info?.shell_pid)
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

// `herdr --version` changes only when the agent does: keep the answer a few
// minutes so a reopened terminal (or a second pane on the same machine) does
// not pay the CLI again -- an SSH round trip on a remote machine.
const VERSION_TTL_MS = 5 * 60 * 1000
const versionCache = new Map<string, { at: number, p: Promise<ExecResult | null> }>()
function herdrVersion(m: Machine): Promise<ExecResult | null> {
  const hit = versionCache.get(m.key)
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.p
  const p = runHerdrCli(m, ['--version'], 4000).catch(() => null)
  versionCache.set(m.key, { at: Date.now(), p })
  return p
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
  // What the client sends before the control session is started. Callbacks
  // and lifecycle metadata travel with the queued object: a scroll replayed
  // on attach still honors its own deadline and cancel tag.
  type ScrollTag = { scroll: true, direction: string, epoch: number, dragLines: number, momentumLines: number }
  const early: { obj: unknown, cb?: { onSubmit?: () => void, onFlush?: () => void }, tag?: ScrollTag, expiresAt?: number }[] = []

  // Backpressure-aware writer: a full kernel buffer pauses the tail, it
  // never resends the chunk that reported `false`. Queued scroll work keeps
  // its tag and deadline so cancels and TTL reach it until submission.
  let writer: ReturnType<typeof createTerminalWriter> | undefined
  const toChild = (obj: unknown, cb?: { onSubmit?: () => void, onFlush?: () => void }, tag?: ScrollTag, expiresAt?: number) => {
    if (!child) {
      if (early.length < 64) early.push({ obj, cb, tag, expiresAt })
    } else if (child.stdin.writable) {
      // Scroll commands are superseded by the next gesture — under a stalled
      // pipe they are the only chunks the writer is allowed to shed.
      const expendable = (obj as { type?: string }).type === 'terminal.scroll'
      writer?.write(JSON.stringify(obj) + '\n', { ...cb, expendable, tag, expiresAt })
    }
  }
  // Every unsent scroll chunk — pacer, throttle and writer queue alike.
  const cancelQueuedScrolls = () => writer?.cancelWhere(e => (e.tag as ScrollTag | undefined)?.scroll === true)

  function start() {
    const c = machine!.spawnHerdr(args)
    child = c
    writer = createTerminalWriter(c.stdin)
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
          for (const { epoch, phase, lines } of scrollDelivered.values())
            ws.send(JSON.stringify({ type: 'scroll.ack', epoch, phase, lines }))
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
      writer?.dispose()
      scroll.dispose()
      touchScroll?.dispose()
      touchMerged.dispose()
      termSessions.delete(sess)
      if (ws.isOpen()) ws.close(4000, `herdr exit ${code}`)
    })
    // No crash if the CLI closes while we write to it.
    c.stdin.on('error', () => {})
    for (const { obj, cb, tag, expiresAt } of early.splice(0)) {
      // A scroll that expired while the child was still starting is stale —
      // replay only work still inside its own deadline.
      if (expiresAt !== undefined && expiresAt <= Date.now()) continue
      toChild(obj, cb, tag, expiresAt)
    }
  }

  // Scrolls merged and rate-limited (see scrollThrottle.ts).
  // Acknowledge sent rows after relaying the next frame. Herdr exposes no
  // applied viewport delta or causal input sequence, so this acknowledges delivery only.
  // Delivery ledger, keyed `${epoch}:${phase}`: drag and momentum stay
  // separate accounts even inside one merged batch. A v2 client (scroll
  // messages carrying `v:2`) additionally receives per-command stages.
  const scrollDelivered = new Map<string, { epoch: number, phase: string, lines: number }>()
  const delivered = (epoch: number, phase: string, lines: number) => {
    const key = `${epoch}:${phase}`
    const entry = scrollDelivered.get(key) || { epoch, phase, lines: 0 }
    entry.lines += lines
    scrollDelivered.set(key, entry)
  }
  let scrollV2 = false
  const scrollCmd = (epoch: number, id: number, phase: string, stage: string) => {
    if (scrollV2 && ws.isOpen()) ws.send(JSON.stringify({ type: 'scroll.cmd', epoch, id, phase, stage }))
  }
  type TouchPosition = ReturnType<typeof terminalScrollPosition> & { epoch: number, preview: boolean, phase: string, id: number }
  let touchScroll: ReturnType<typeof createTouchScrollPacer<TouchPosition>> | undefined
  // Preserve the legacy wire contract, and allocate no pacer for default clients.
  const scroll = createScrollThrottle((direction, lines) => toChild({ type: 'terminal.scroll', direction, lines }))
  const pacedTouch = () => touchScroll ||= createTouchScrollPacer<TouchPosition>((direction, lines, position, expiresAt) => {
    if (!position) return
    const { epoch, preview, phase, id, ...cell } = position
    const signed = direction === 'up' ? lines : -lines
    // submitted/delivered only when the bytes actually enter the stream —
    // a chunk queued inside the writer under backpressure is not sent yet.
    // Its tag and deadline ride along so cancels and TTL reach it there too.
    toChild({ type: 'terminal.scroll', direction, lines, ...cell }, {
      onSubmit: () => { delivered(epoch, phase, signed); scrollCmd(epoch, id, phase, 'submitted') },
      // The stream callback carries an error on a failed write — 'flushed'
      // means the kernel took the bytes; anything else is its own fact.
      onFlush: err => scrollCmd(epoch, id, phase, err ? 'writeFailed' : 'flushed'),
    }, {
      scroll: true, direction, epoch,
      dragLines: phase === 'drag' ? Math.abs(signed) : 0,
      momentumLines: phase === 'momentum' ? Math.abs(signed) : 0,
    }, expiresAt)
  })
  // Panes without mouse-report need no per-tick wheel reports: Herdr honors
  // lines:N there, so merge touch drags into one command per repaint instead
  // of one frame per row. The merged batch still counts toward the gesture's
  // epoch for compatibility with clients consuming scroll.ack. `mergedContrib`
  // attributes the merged total back to (epoch, phase) in send order.
  // Contributions are a raw signed append log — NO pre-netting. The
  // throttle's tagged cancel must be able to remove a phase cleanly, which
  // pre-netted entries would make unrecoverable. At flush the batch is
  // attributed oldest-first over same-sign entries; opposite-sign leftovers
  // simply wait (bounded by the epoch).
  const mergedContrib: { epoch: number, phase: string, lines: number }[] = []
  const addContrib = (epoch: number, phase: string, signed: number) => {
    mergedContrib.push({ epoch, phase, lines: signed })
  }
  const touchMerged = createScrollThrottle((direction, lines) => {
    // Consume the contribution log now, report delivery when the bytes
    // really enter the stream (onSubmit) — a chunk dropped by the bounded
    // writer or stalled under backpressure is honestly never delivered.
    const attrib: { epoch: number, phase: string, lines: number }[] = []
    let rest = lines
    const dirSign = direction === 'up' ? 1 : -1
    for (let i = 0; rest > 0 && i < mergedContrib.length;) {
      const c = mergedContrib[i]!
      if (Math.sign(c.lines) !== dirSign) { i++; continue }
      const take = Math.min(Math.abs(c.lines), rest)
      c.lines -= dirSign * take
      rest -= take
      attrib.push({ epoch: c.epoch, phase: c.phase, lines: dirSign * take })
      if (!c.lines) mergedContrib.splice(i, 1); else i++
    }
    // The throttle's post-flush net is zero: anything left in the log was
    // netting residue or clamped by its line cap — never sendable input.
    mergedContrib.length = 0
    // The batch keeps a phase ledger in its tag: a phase-cancel may drop a
    // pure-momentum batch, but never one holding real drag input. Lines
    // without ledger credit count as drag — conservative against losing
    // input to a stale tag.
    const dragLines = attrib.filter(a => a.phase === 'drag').reduce((n, a) => n + Math.abs(a.lines), 0) + rest
    const momentumLines = attrib.filter(a => a.phase === 'momentum').reduce((n, a) => n + Math.abs(a.lines), 0)
    toChild({ type: 'terminal.scroll', direction, lines }, attrib.length
      ? { onSubmit: () => attrib.forEach(a => delivered(a.epoch, a.phase, a.lines)) }
      : undefined,
      { scroll: true, direction, epoch: 0, dragLines, momentumLines })
  }, { intervalMs: 30 })
  const cancelMerged = () => { touchMerged.cancel(); mergedContrib.length = 0 }
  // Full touch cancellation clears every queue stage: pacer ticks, merged
  // net, contribution ledger, and scroll chunks still waiting in the writer.
  const cancelTouchWork = () => { touchScroll?.cancel(); cancelMerged(); cancelQueuedScrolls() }
  let scrollbackSeq = 0

  // The pane's size is read before the control session resizes it (see paneSizes.ts).
  // `herdr --version` does not depend on it: fired alongside, so the CLI's
  // own round trip (SSH on a remote machine) is not serialized after the
  // size read. The answer is also cached -- it only changes with the agent.
  const versionP = machine ? herdrVersion(machine) : Promise.resolve(null)
  paneSizes().hold(pane).then(async (h) => {
    if (closed) return h.release(true)
    hold = h
    const version = await versionP
    if (closed) return
    const state = getState()
    const serverVersion = state.machines?.find(m => m.key === machine!.key)?.version ?? (machine!.key === '' ? state.version : '')
    mouse = version?.code === 0 && hasTerminalMouse(version.stdout.toString('utf8')) && hasTerminalMouse(serverVersion || '')
    if (ws.isOpen()) ws.send(JSON.stringify({ type: 'web.capabilities', mouse, scroll: 2 }))
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
          cancelTouchWork()
          if (typeof m.text === 'string' && m.text.length <= 65536) toChild({ type: 'terminal.input', text: m.text })
          else if (typeof m.bytes === 'string' && m.bytes.length <= 90000) toChild({ type: 'terminal.input', bytes: m.bytes })
          break
        case 'terminal.mouse': {
          cancelTouchWork()
          const event = mouse && cleanTerminalMouse(m, size.cols, size.rows)
          if (event) toChild(event)
          break
        }
        case 'terminal.resize': {
          cancelTouchWork()
          size = { cols: clampInt(m.cols, 10, 400, cols), rows: clampInt(m.rows, 5, 200, rows) }
          if (attached) hold?.resized(size.cols, size.rows)
          toChild({ type: 'terminal.resize', ...size })
          break
        }
        case 'terminal.scroll':
          if (m.direction === 'up' || m.direction === 'down') {
            if (m.v === 2) scrollV2 = true
            if (m.source === 'touch') {
              // tui = the pane's live mouse-report/alt-screen state as seen by
              // the client's xterm. Older clients send no tui; fall back to
              // the herdr capability flag.
              const tui = m.tui === undefined ? mouse : m.tui === true
              const phase = m.phase === 'momentum' || m.preview === false ? 'momentum' : 'drag'
              const epoch = clampInt(m.epoch, 0, Number.MAX_SAFE_INTEGER, 0)
              // A reversed gesture supersedes opposite-direction work still
              // waiting in the writer — the pacer already clears its side.
              writer?.cancelWhere(e => {
                const t = e.tag as ScrollTag | undefined
                return t?.scroll === true && t.direction !== m.direction
              })
              if (tui) {
                pacedTouch().push(m.direction, clampInt(m.lines, 1, 500, 3), {
                  ...terminalScrollPosition(m, size.cols, size.rows),
                  epoch, preview: m.preview !== false, phase,
                  id: clampInt(m.id, 0, Number.MAX_SAFE_INTEGER, 0),
                }, phase === 'momentum' ? 240 : 800)
              }
              else {
                addContrib(epoch, phase, (m.direction === 'up' ? 1 : -1) * clampInt(m.lines, 1, 500, 3))
                touchMerged.push(m.direction, clampInt(m.lines, 1, 500, 3), phase)
              }
            }
            else { cancelTouchWork(); scroll.push(m.direction, clampInt(m.lines, 1, 500, 3)) }
          }
          break
        case 'touch.cancel':
          if (m.phase === 'momentum') {
            // Phase cancel: drop expendable momentum only. Queued drags —
            // which may still be owed to a finger that is down — survive.
            touchScroll?.cancelWhere(position => position?.phase === 'momentum')
            touchMerged.cancelTagged('momentum')
            for (let i = mergedContrib.length - 1; i >= 0; i--) if (mergedContrib[i]!.phase === 'momentum') mergedContrib.splice(i, 1)
            // Pure-momentum chunks in the writer die too; a merged batch
            // holding any drag input survives — that input is real.
            writer?.cancelWhere(e => {
              const t = e.tag as ScrollTag | undefined
              return t?.scroll === true && t.momentumLines > 0 && t.dragLines === 0
            })
            break
          }
          cancelTouchWork()
          if (m.disabled === true) { touchScroll?.dispose(); touchScroll = undefined }
          scrollDelivered.clear()
          break
        // The client renders scrollback locally in a native scroller, so the
        // terminal itself never leaves the bottom for history browsing.
        case 'scrollback.read': {
          const seq = ++scrollbackSeq
          // 'recent' wraps at pane width (physical rows for the transcript
          // scroller); 'recent_unwrapped' keeps logical lines (history dump).
          const source = m.source === 'recent' ? 'recent' : 'recent_unwrapped'
          herdr('pane.read', { pane_id: pane, source, lines: clampInt(m.lines, 1, 4000, 800), format: 'ansi' }, 8000)
            .then(r => { if (seq === scrollbackSeq && ws.isOpen()) ws.send(JSON.stringify({ type: 'scrollback.chunk', text: String(r?.read?.text || '') })) })
            .catch(() => { if (seq === scrollbackSeq && ws.isOpen()) ws.send(JSON.stringify({ type: 'scrollback.chunk', text: '' })) })
          break
        }
        case 'keys': // logical keys encoded by Herdr according to the terminal mode
          cancelTouchWork()
          if (Array.isArray(m.keys) && m.keys.length <= 32 && m.keys.every((k: unknown) => typeof k === 'string' && k.length <= 24)) {
            herdr('pane.send_input', { pane_id: pane, keys: m.keys }).catch(e =>
              ws.isOpen() && ws.send(JSON.stringify({ type: 'web.error', code: e.code, message: e.message })))
          }
          break
        // Pasted text, as Herdr's pane input: omp receives it as a paste and
        // turns an image path into an image (typed through wherdr's xterm, which
        // never learns the program's bracketed paste mode, it stays text).
        case 'paste':
          cancelTouchWork()
          if (typeof m.text === 'string' && m.text && m.text.length <= 65536) {
            herdr('pane.send_input', { pane_id: pane, text: m.text }).catch(e =>
              ws.isOpen() && ws.send(JSON.stringify({ type: 'web.error', code: e.code, message: e.message })))
          }
          break
        case 'visibility':
          sess.visible = Boolean(m.visible)
          if (!sess.visible) cancelTouchWork()
          break
      }
    },
    onClose(clean = false) {
      closed = true
      scroll.dispose()
      touchScroll?.dispose()
      touchMerged.dispose()
      mergedContrib.length = 0
      termSessions.delete(sess)
      const c = child
      if (c) {
        // Hand control back cleanly (the pane size goes back to the other clients).
        // Drop queued scroll chunks first: end() would cut them anyway, and
        // release must not wait behind a backpressured tail.
        writer?.dispose()
        if (c.stdin.writable) c.stdin.write(JSON.stringify({ type: 'terminal.release' }) + '\n')
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
    // A standalone control session — no shared writer here.
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
