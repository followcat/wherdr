// Fake `herdr` CLI for the end-to-end tests: only `terminal session control`
// (the terminal's control session, see server/utils/terminal.ts), played
// against the fake Herdr server, and `integration status`; every other command fails.
//   node fake-herdr-cli.mjs <socket> [--session <name>] terminal session control <pane> [--takeover] --cols N --rows N
import net from 'node:net'
import readline from 'node:readline'

const [sock, ...argv] = process.argv.slice(2)
const args = argv[0] === '--session' ? argv.slice(2) : argv

function call(method, params) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock)
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('error', reject)
    conn.on('connect', () => conn.write(JSON.stringify({ id: 'cli', method, params }) + '\n'))
    conn.on('data', (chunk) => { buf += chunk })
    conn.on('end', () => {
      try {
        const res = JSON.parse(buf)
        if (res.error) reject(new Error(res.error.message))
        else resolve(res.result)
      } catch (e) { reject(e) }
    })
  })
}

if (args[0] === '--version') {
  const { version } = await call('e2e.terminal_version', {})
  console.log(`herdr ${version}`)
  process.exit(0)
}

// `herdr integration status`: the states set by the specs (e2e.integrations).
if (args[0] === 'integration' && args[1] === 'status') {
  const { states } = await call('e2e.integration_states', {})
  const file = { claude: '~/.claude/hooks/herdr-agent-state.sh', codex: '~/.codex/herdr-agent-state.sh', omp: '~/.omp/agent/extensions/herdr-omp-agent-state.ts' }
  for (const [agent, path] of Object.entries(file)) {
    process.stdout.write(`${agent}: ${states[agent] === 'missing' ? 'not installed' : 'current (v10)'} (${path})\n`)
  }
  process.exit(0)
}

const command = args.slice(0, 3).join(' ')
if (command !== 'terminal session control') {
  console.error('herdr is not available in the e2e tests')
  process.exit(1)
}

const pane = args[3]
const opt = name => Number(args[args.indexOf(name) + 1])
const session = `cli-${process.pid}`
const out = obj => process.stdout.write(JSON.stringify(obj) + '\n')
let seq = 0
let currentSize
let currentText = ''
const frame = (size, text = '') => out({
  type: 'terminal.frame', encoding: 'ansi', full: true, width: size.cols, height: size.rows, seq: ++seq,
  bytes: Buffer.from(`\x1b[2J\x1b[H${text ? text.replace(/\n/g, '\r\n') : `fake terminal ${size.cols}x${size.rows}\r\n${pane} tick ${seq}\r\n$ `}`).toString('base64'),
})

let done = false
let pollTimer
async function leave(code) {
  if (done) return
  done = true
  clearInterval(pollTimer)
  await call('e2e.term_detach', { pane_id: pane, session }).catch(() => {})
  process.exit(code)
}

// Live frames for scripted interactive screens; ordinary terminal-size tests
// retain their original frames and size behaviour.
pollTimer = setInterval(async () => {
  const r = await call('e2e.terminal_screen', { pane_id: pane }).catch(() => null)
  if (r && !done) currentText = r.text
  for (const data of r?.osc || []) {
    if (done || !currentSize) break
    out({ type: 'terminal.frame', encoding: 'ansi', full: false, width: currentSize.cols, height: currentSize.rows, seq: ++seq, bytes: Buffer.from(data).toString('base64') })
  }
}, 200)

try {
  currentSize = await call('e2e.term_attach', { pane_id: pane, session, cols: opt('--cols'), rows: opt('--rows'), takeover: args.includes('--takeover') })
  frame(currentSize)
} catch (e) {
  out({ type: 'terminal.closed', reason: e.message })
  process.exit(1)
}

// Independent output continues in every attached pane, including inactive cells.
setInterval(() => frame(currentSize, currentText), 150).unref()

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m
  try { m = JSON.parse(line) }
  catch { return }
  if (m.type === 'terminal.resize') {
    const size = await call('e2e.term_resize', { pane_id: pane, session, cols: m.cols, rows: m.rows }).catch(() => null)
    if (size) { currentSize = size; frame(size) }
    else {
      // Another session took the terminal over.
      out({ type: 'terminal.closed', reason: 'taken over' })
      leave(0)
    }
  } else if (m.type === 'terminal.release') {
    out({ type: 'terminal.closed', reason: 'detached' })
    leave(0)
  } else if (m.type === 'terminal.scroll') {
    const state = await call('e2e.touch_scroll', { pane_id: pane, event: m }).catch(() => null)
    if (state?.text && state.frame !== false) { currentText = state.text; frame(currentSize, currentText) }
  } else if (m.type === 'terminal.mouse') {
    await call('e2e.terminal_mouse', { pane_id: pane, event: m }).catch(() => {})
  } else if (m.type === 'terminal.input') {
    const text = m.text || ''
    const keys = [...text].map(c => c === '\x1b' ? 'esc' : c === '\r' ? 'enter' : c)
    await call('pane.send_input', { pane_id: pane, keys }).catch(() => {})
  }
}).on('close', () => leave(0))
process.on('SIGTERM', () => leave(0))
