// Measure the touch-scroll pipeline against a live wherdr terminal ws.
// Simulates a fast finger drag (source:'touch') and records when frames/acks
// come back. Run on the server itself to isolate server+agent speed from network RTT.
// usage: WHERDR=wss://host:port node scroll-probe-ts.mjs <pane> [lines] [spanMs] [cols] [rows]
import WebSocket from 'ws'

const pane = process.argv[2]
const LINES = Number(process.argv[3] || 120)
const SPAN = Number(process.argv[4] || 500)
const COLS = Number(process.argv[5] || 80)
const ROWS = Number(process.argv[6] || 24)
if (!pane || !process.env.WHERDR) {
  console.error('usage: WHERDR=wss://host:port node scroll-probe-ts.mjs <pane> [lines] [spanMs] [cols] [rows]')
  process.exit(64)
}
const base = process.env.WHERDR.replace(/\/$/, '')
const url = `${base}/ws/term?pane=${pane}&cols=${COLS}&rows=${ROWS}`
const ws = new WebSocket(url, { rejectUnauthorized: false, headers: { origin: base.replace(/^ws/, 'http') } })
const t0 = Date.now()
const t = () => Date.now() - t0
let caps = null
const sent = []          // {at, lines, epoch}
const frames = []        // frame arrival times
const acks = []          // {at, epoch, lines}
let done = false

ws.on('open', () => console.log(`[${t()}ms] open ${url}`))
ws.on('message', (raw) => {
  let m
  try { m = JSON.parse(raw) } catch { return }
  if (m.type === 'web.capabilities') {
    caps = m
    console.log(`[${t()}ms] capabilities mouse=${m.mouse}`)
    // Simulate a flick: LINES rows spread over SPAN ms, like one fast drag.
    const steps = Math.ceil(LINES / 2)
    let i = 0
    const tick = () => {
      if (i >= steps) return
      sent.push({ at: t(), lines: 2 })
      try {
        ws.send(JSON.stringify({
        type: 'terminal.scroll', direction: 'up', lines: 2,
        column: 40, row: 12, modifiers: 0, source: 'touch', epoch: 1, preview: true,
      })) } catch (e) { console.log(`[${t()}ms] send failed: ${e.message}`); return }
      i++
      setTimeout(tick, SPAN / steps)
    }
    tick()
    // Report 3.5s after the gesture ends.
    setTimeout(report, SPAN + 3500)
  } else if (m.type === 'terminal.frame') {
    frames.push(t())
  } else if (m.type === 'scroll.ack') {
    acks.push({ at: t(), epoch: m.epoch, lines: m.lines })
  } else if (m.type === 'web.error' || m.type === 'terminal.closed') {
    console.log(`[${t()}ms] ${m.type}: ${m.message || m.reason || ''}`)
  }
})
ws.on('error', e => { console.log('ws error', e.message); done = true })
ws.on('close', (c, r) => { if (!done) console.log(`[${t()}ms] close ${c} ${r}`) })

function report() {
  done = true
  const lastSent = sent.at(-1)?.at ?? 0
  console.log(`\n=== drag: ${sent.length} cmds (${sent.reduce((n, s) => n + s.lines, 0)} lines) over ${lastSent}ms ===`)
  const after = frames.filter(f => f > lastSent)
  console.log(`frames: ${frames.length} total, first=${frames[0]}ms, after-drag=${after.length} (last=${after.at(-1)}ms)`)
  if (after.length > 1) {
    const gaps = after.slice(1).map((f, i) => f - after[i])
    console.log(`frame gaps after drag: min=${Math.min(...gaps)} median=${gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]} max=${Math.max(...gaps)}`)
  }
  console.log(`acks: ${JSON.stringify(acks)}`)
  const ackTotal = acks.reduce((n, a) => n + (a.lines || 0), 0)
  console.log(`acked lines=${ackTotal} of ${sent.reduce((n, s) => n + s.lines, 0)} sent`)
  ws.close()
  setTimeout(() => process.exit(0), 300)
}
setTimeout(() => { console.log('timeout'); process.exit(2) }, 20000)
