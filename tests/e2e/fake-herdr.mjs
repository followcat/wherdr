// Fake Herdr API server for the end-to-end tests: speaks Herdr's socket
// protocol (line-delimited JSON over a Unix socket, one connection per
// request: {id, method, params} -> {id, result} or {id, error: {code, message}})
// and answers from a fixed in-memory session. No real Herdr is ever involved.
import fs from 'node:fs'
import net from 'node:net'
import { writeDevinFixture } from '../helpers/devin-fixture.mjs'

// Delay of agent.prompt, so the app's "sending…" state is observable.
export const PROMPT_DELAY_MS = 1500

// What an agent's pane shows: a real omp at rest has its input field ("╰─"
// line) on screen, which the app checks before typing a message into it (it
// holds messages while a dialog hides the field). Other panes: blank.
const OMP_IDLE_SCREEN = [
  '',
  ' Ready when you are.',
  '',
  ' π > Opus > demo ▶─1%───────────────────────────────────────────────1M─',
  '╰─ ',
].join('\n')
// omp running the user's "!" command, nerd-font symbols (Escape drawn as
// U+F12B7), as omp 18.6 shows it; Escape cancels it.
const OMP_RULE = '─'.repeat(70)
const ompRunScreen = command => [
  '', OMP_RULE, ` $ ${command}`, '', ' ⠸ Running… (\u{F12B7} to cancel)', OMP_RULE,
  ' π > Opus > demo ▶─1%───────────────────────────────────────────────1M─',
  '╰─ ',
].join('\n')
// `ask`: the question a waiting agent shows (e2e.ask), until Enter answers it.
const screen = p => p?.customScreen ?? p?.ask ?? p?.updateOutput ?? (p?.agent === 'omp' && p.status === 'idle' ? (p.run ? ompRunScreen(p.run) : OMP_IDLE_SCREEN) : '')

// A tab's area, in cells; two panes share it side by side (one split).
const AREA = { x: 0, y: 0, width: 120, height: 40 }
const HALVES = [{ x: 0, y: 0, width: 60, height: 40 }, { x: 61, y: 0, width: 59, height: 40 }]

// `workspaces`: [{ id, label, panes: [{ id, agent, status, cwd, session, transcript, reply, shell }] }]
// (`session`: the value Herdr's agent integration reports; `transcript`: the file
// the fake agent appends to when it receives a prompt; `shell`: a "!" prompt
// starts a run that lasts until Escape, written nowhere, like a fresh omp).
export function startFakeHerdr({ sock, workspaces, log = () => {} }) {
  const allWorkspaces = workspaces
  // `size`: the pane's PTY. No Herdr client is attached to this session: a
  // terminal control session resizes it, and it keeps that size afterwards.
  // `control`: the control session attached to the pane's terminal, if any.
  const panes = workspaces.flatMap(w => w.panes.map((p, i) => {
    const rect = w.panes.length === 2 ? HALVES[i] : AREA
    return { ...p, workspace: w.id, size: { cols: rect.width, rows: rect.height }, control: null }
  }))
  const allPanes = panes
  const paneById = id => panes.find(p => p.id === id)

  function snapshot() {
    const gone = new Set(allPanes.filter(p => p.hidden).map(p => p.id))
    const workspaces = allWorkspaces.map(w => ({ ...w, panes: w.panes.filter(p => !gone.has(p.id)) }))
    const panes = allPanes.filter(p => !p.hidden)
    return {
      version: terminalVersion,
      workspaces: workspaces.map((w, i) => ({
        workspace_id: w.id, label: w.label, number: i + 1, focused: i === 0,
        agent_status: w.panes[0]?.status || 'unknown', active_tab_id: `${w.id}:t1`,
        tab_count: 1, pane_count: w.panes.length,
      })),
      tabs: workspaces.map(w => ({
        tab_id: `${w.id}:t1`, workspace_id: w.id, label: '1', number: 1, focused: true,
        agent_status: w.panes[0]?.status || 'unknown', pane_count: w.panes.length,
      })),
      layouts: workspaces.map(w => ({
        tab_id: `${w.id}:t1`, workspace_id: w.id, zoomed: false,
        area: AREA,
        focused_pane_id: w.panes[0]?.id,
        panes: w.panes.map((p, i) => ({ pane_id: p.id, focused: i === 0, rect: w.panes.length === 2 ? HALVES[i] : AREA })),
        splits: w.panes.length === 2 ? [{ id: 'split_0_root', direction: 'right', ratio: 0.5, rect: AREA }] : [],
      })),
      panes: panes.map(p => ({
        pane_id: p.id, workspace_id: p.workspace, tab_id: `${p.workspace}:t1`,
        agent: p.agent, agent_status: p.status, cwd: p.cwd, foreground_cwd: p.cwd, focused: false,
        terminal_title: p.agent || 'shell',
        terminal_id: `term_${p.id.replace(/\W/g, '')}`,
        scroll: { viewport_rows: p.size.rows, offset_from_bottom: 0, max_offset_from_bottom: 0 },
        ...(p.session ? { agent_session: { agent: p.agent, value: p.session } } : {}),
      })),
      agents: [],
    }
  }

  // The fake agent "reads" the prompt: the message, then a short reply, land in
  // its transcript (omp format) once the delay is over.
  async function prompt(params) {
    const p = paneById(params.target)
    if (!p) throw Object.assign(new Error(`No pane ${params.target}`), { code: 'pane_not_found' })
    p.prompts = [...(p.prompts || []), params]
    await new Promise(r => setTimeout(r, PROMPT_DELAY_MS))
    if (p.shell && /^\s*!/.test(String(params.text))) p.run = String(params.text).replace(/^\s*!+\s*/, '')
    else if (p.agent === 'omp' && p.transcript) {
      const at = Date.now()
      const line = (id, ts, message) => JSON.stringify({ type: 'message', id, timestamp: new Date(ts).toISOString(), message: { ...message, timestamp: ts } })
      fs.appendFileSync(p.transcript, [
        line(`u${at}`, at, { role: 'user', content: [{ type: 'text', text: String(params.text) }], attribution: 'user' }),
        line(`a${at}`, at + 1, { role: 'assistant', content: [{ type: 'text', text: p.reply || 'Noted.' }], stopReason: 'stop' }),
      ].join('\n') + '\n')
    }
    return { agent: { pane_id: p.id, agent: p.agent, status: p.status } }
  }

  function need(id) {
    const p = paneById(id)
    if (!p) throw Object.assign(new Error(`No pane ${id}`), { code: 'pane_not_found' })
    return p
  }

  // Apply an invocation reset at the start of a poll, never between its
  // session snapshot and its process/transcript reads.
  const snapshotActions = []
  function resetUpdate(params) {
    const p = need(params.pane_id)
    p.agent = 'codex'; p.status = 'idle'; p.pid = (p.pid || 3000) + 1
    p.updateOutput = params.session ? '' : '✨ Update available! 0.148.0 -> 0.162.1'; p.foreground = false; p.starts = []
    p.processReads = 0
    p.argv = null; p.writes = []; p.prompts = []
    p.baseCwd ||= p.cwd
    p.cwd = params.session ? p.baseCwd : `${p.baseCwd}/fresh`
    p.session = params.session || null
    return { pid: p.pid }
  }

  let terminalVersion = '0.9.1'
  const terminalMouse = []
  let integrations = {}
  let plugins = []
  const methods = {
    'e2e.devin': params => {
      const p = need(params.pane_id)
      if (!p.devinHome) throw new Error('No isolated Devin fixture for this pane')
      if (params.reset) {
        if (p.devinOriginal) Object.assign(p, p.devinOriginal)
        delete p.devinOriginal
        return {}
      }
      p.devinOriginal ||= { agent: p.agent, session: p.session }
      writeDevinFixture(p.devinHome, { session: 'e2e-devin', rows: params.rows || [], head: params.head, states: params.states || [] })
      p.agent = 'devin'
      p.session = 'e2e-devin'
      return {}
    },
    'e2e.terminal_version': params => {
      if (params.version) { terminalVersion = params.version; terminalMouse.length = 0 }
      return { version: terminalVersion }
    },
    'e2e.terminal_mouse': params => {
      if (params.event) terminalMouse.push(params)
      return { events: terminalMouse }
    },
    // Simulate a server that acknowledges a rename but leaves the name intact.
    'workspace.rename': () => ({}),
    'tab.rename': () => ({}),
    'session.snapshot': () => {
      for (const action of snapshotActions.splice(0)) action()
      return { snapshot: snapshot() }
    },
    'agent.prompt': prompt,
    'agent.get': (params) => {
      const p = paneById(params.target)
      if (!p) throw Object.assign(new Error(`No agent ${params.target}`), { code: 'agent_not_found' })
      return { agent: { pane_id: p.id, agent: p.agent, status: p.status } }
    },
    'pane.get': (params) => {
      const p = paneById(params.pane_id)
      if (!p) throw Object.assign(new Error(`No pane ${params.pane_id}`), { code: 'pane_not_found' })
      return { pane: snapshot().panes.find(x => x.pane_id === p.id) }
    },
    'pane.read': async params => {
      const p = paneById(params.pane_id)
      if (p?.readFailure && params.source === 'detection') throw Object.assign(new Error('Transient detection read failure'), { code: 'timeout' })
      if (p?.readDelayMs) await new Promise(r => setTimeout(r, p.readDelayMs))
      const raw = screen(p)
      // Herdr detection/visible reads are plain unless ANSI was requested.
      // eslint-disable-next-line no-control-regex
      const text = params.format === 'ansi' ? raw : raw.replace(/\x1b\[[0-9;]*m|\r/g, '')
      return { read: { pane_id: params.pane_id, source: params.source || 'visible', text } }
    },
    'pane.process_info': (params) => {
      const p = paneById(params.pane_id)
      if (p) p.processReads = (p.processReads || 0) + 1
      const procs = p?.agent ? [{ pid: p.pid || 2001, name: p.agent, argv: p.argv || [p.agent, ...(p.agent === 'codex' ? ['--profile', 'work', '-m', 'gpt-x'] : [])] }] : [{ pid: 2000, name: 'zsh' }]
      return { process_info: { shell_pid: 2000, foreground_process_group_id: p?.foreground ? 4000 : p?.agent ? (p.pid || 2001) : 2000, foreground_processes: procs } }
    },
    'e2e.update_reset': params => {
      need(params.pane_id)
      return params.onSnapshot
        ? new Promise(resolve => snapshotActions.push(() => resolve(resetUpdate(params))))
        : resetUpdate(params)
    },
    'e2e.update_exit': params => {
      const p = need(params.pane_id)
      p.agent = null; p.status = 'unknown'; p.session = null
      // `plain`: Codex simply left (/exit), no update.
      p.updateOutput = (params.plain ? '' : 'Codex CLI 0.162.1 installed successfully.\n\n🎉 Update ran successfully! Please restart Codex.\n\n') + 'user@host project % ' + (params.draft || '')
      return {}
    },
    'e2e.update_replace': params => {
      const p = need(params.pane_id)
      p.pid++; p.argv = params.argv
      return { pid: p.pid }
    },
    // Herdr integrations as `herdr integration status` reports them (all
    // installed unless a spec says otherwise): { codex: 'missing' }…
    'e2e.integrations': params => { integrations = { ...(params.states || {}) }; return {} },
    'e2e.integration_states': () => ({ states: integrations }),
    'e2e.pane_status': params => { need(params.pane_id).status = params.status; return {} },
    // Herdr closes the pane and opens another one for the same agent (same
    // conversation, as herdr-projects restarting a coordinator): a new id.
    'e2e.replace_pane': (params) => {
      const p = need(params.pane_id)
      const w = workspaces.find(x => x.id === p.workspace)
      const at = w.panes.findIndex(x => x.id === p.id)
      w.panes[at] = { ...w.panes[at], id: params.new_id }
      p.id = params.new_id
      return {}
    },
    // Herdr closes the pane for good (`hidden: false` brings it back).
    'e2e.hide_pane': (params) => { need(params.pane_id).hidden = Boolean(params.hidden); return {} },
    'e2e.update_session': params => { need(params.pane_id).session = params.session; return {} },
    'e2e.update_draft': params => { need(params.pane_id).updateOutput += params.text; return {} },
    'e2e.update_foreground': params => { need(params.pane_id).foreground = true; return {} },
    'e2e.update_starts': params => {
      const p = need(params.pane_id)
      return { starts: p.starts || [], reads: p.processReads || 0, writes: p.writes || [], prompts: p.prompts || [] }
    },
    // An agent starts waiting on a question (`screen`: what its pane shows), or
    // goes back to rest (no `screen`). `e2e.answers`: the keys that answered it.
    'e2e.ask': params => {
      const p = need(params.pane_id)
      p.ask = params.screen || null; p.status = p.ask ? 'blocked' : 'idle'; p.answers = []
      return {}
    },
    'e2e.answers': params => ({ answers: need(params.pane_id).answers || [] }),
    'agent.start': params => {
      const p = need(params.pane_id)
      p.starts = [...(p.starts || []), params]
      p.agent = params.kind; p.status = 'idle'; p.pid = (p.pid || 3000) + 1; p.updateOutput = params.kind === 'codex' ? '› ' : ''
      // Only the screen given by the spec: no `updateOutput` left behind on this pane.
      if (p.slowExit?.exiting) { p.customScreen = p.slowExit.after; p.updateOutput = undefined; p.slowExit = null }
      return { agent: { pane_id: p.id, agent: p.agent } }
    },
    'pane.send_input': (params) => {
      const p = paneById(params.pane_id)
      if (p) p.writes = [...(p.writes || []), params]
      // `/exit` then Enter: the exit screen, the agent still reported for `ms`.
      if (p?.slowExit && params.text === '/exit') p.slowExit.typed = true
      if (p?.slowExit?.typed && (params.keys || []).includes('enter')) {
        p.slowExit = { ...p.slowExit, typed: false, exiting: true }
        p.customScreen = p.slowExit.screen
        setTimeout(() => { p.agent = null; p.status = 'unknown' }, p.slowExit.ms)
        return {}
      }
      if (p?.run && (params.keys || []).includes('esc')) p.run = null
      if (p?.customScreen !== undefined && p.customScreen !== null) {
        p.sentKeys ||= []
        p.sentKeys.push(...(params.keys || []))
        for (const key of params.keys || []) {
          const next = p.screenTransitions?.[key]
          if (typeof next === 'string') p.customScreen = next
          else if (next) { p.customScreen = next.text; p.screenTransitions = next.transitions || null }
        }
        if ((params.keys || []).includes('esc')) p.customScreen = '› Ask Codex to do anything\n\n  GPT-6-Sol medium · demo'
      }
      if (p?.ask && (params.keys || []).includes('enter')) {
        p.answers = [...(p.answers || []), params.keys]
        p.ask = null; p.status = 'idle'
      }
      return {}
    },
    // The agent quits slowly on `/exit`: Herdr keeps reporting it while its
    // exit screen (`screen`) shows; `agent.start` then shows `after`.
    'e2e.slow_exit': params => {
      need(params.pane_id).slowExit = params.ms ? { ms: params.ms, screen: params.screen, after: params.after } : null
      return {}
    },
    'e2e.read_failure': params => { need(params.pane_id).readFailure = Boolean(params.fail); return {} },
    'e2e.interaction_screen': params => {
      const p = need(params.pane_id)
      p.customScreen = params.text ?? null
      if (params.agent) p.agent = params.agent
      if (params.status) p.status = params.status
      p.sentKeys = []
      p.screenTransitions = params.transitions || null
      p.readDelayMs = params.readDelayMs || 0
      return {}
    },
    // Explicit scroll fixture: mouse apps consume `wheelRowsPerTick` rows per
    // wheel report; ordinary history consumes `lines`, matching Herdr's two
    // paths. Fault knobs (terminal scroll suite):
    //   consumeDelayMs    events apply this late — a slow or stalled consumer
    //   wheelRowsPerTick  a tick is not always one row (app-defined semantic)
    //   noFrameAtBoundary scrolls clamped at an edge emit no movement frame
    'e2e.touch_scroll': params => {
      const p = need(params.pane_id)
      if (params.reset) p.touchScroll = { offset: 0, events: [], mouse: !!params.mouse, pending: [], wheelRowsPerTick: 1, consumeDelayMs: 0, noFrameAtBoundary: false }
      if (params.clear) { p.touchScroll = null; return {} }
      const state = p.touchScroll
      if (!state) return {}
      for (const key of ['wheelRowsPerTick', 'consumeDelayMs', 'noFrameAtBoundary'])
        if (typeof params[key] === 'number' || typeof params[key] === 'boolean') state[key] = params[key]
      if (typeof params.offset === 'number') state.offset = Math.max(0, Math.min(80, params.offset))
      if (params.event) {
        state.events.push(params.event)
        state.pending.push({ event: params.event, at: Date.now() + state.consumeDelayMs })
      }
      // Apply whatever is due, strictly in order: a slow consumer serializes
      // later input behind its head event rather than letting it overtake.
      const now = Date.now()
      let moved = false, clamped = false, applied = 0
      while (state.pending.length && state.pending[0].at <= now) {
        const { event } = state.pending.shift()
        applied++
        const n = state.mouse ? state.wheelRowsPerTick : event.lines
        const next = state.offset + (event.direction === 'up' ? n : -n)
        const clampedNext = Math.max(0, Math.min(80, next))
        if (clampedNext !== next) clamped = true
        if (clampedNext !== state.offset) moved = true
        state.offset = clampedNext
      }
      // A scroll clamped at the boundary moves nothing: opaque apps may still
      // repaint, history panes stay put. Specs read `applied` for causality.
      // lastFrame records the flag for the latest CONSUMED event — a bare
      // status read must not overwrite the evidence a spec is asserting on.
      const frame = applied ? (moved || !(clamped && state.noFrameAtBoundary)) : true
      if (applied) state.lastFrame = frame
      return { ...state, pending: state.pending.length, applied, frame,
        text: `History offset ${state.offset}\n` + Array.from({ length: Math.max(1, p.size.rows - 1) }, (_, i) => `History row ${100 - state.offset + i}`).join('\n') }
    },
    'e2e.terminal_screen': params => {
      const p = need(params.pane_id)
      const osc = p.osc || []
      p.osc = []
      return { text: p.touchScroll ? methods['e2e.touch_scroll'](params).text : p.customScreen || '', size: p.size, keys: p.sentKeys || [], osc }
    },
    // Raw sequences (OSC 52…) the control session writes once, after the screen.
    'e2e.terminal_osc': params => {
      const p = need(params.pane_id)
      ;(p.osc ||= []).push(params.data)
      return {}
    },
    'pane.layout': (params) => {
      const p = need(params.pane_id)
      return { layout: snapshot().layouts.find(l => l.workspace_id === p.workspace) }
    },
    // Control session of a pane's terminal (tests/e2e/fake-herdr-cli.mjs).
    'e2e.term_attach': (params) => {
      const p = need(params.pane_id)
      if (p.control && !params.takeover) throw Object.assign(new Error('terminal already has an attached client'), { code: 'terminal_attached' })
      p.control = params.session
      p.size = { cols: params.cols || p.size.cols, rows: params.rows || p.size.rows }
      return p.size
    },
    'e2e.term_resize': (params) => {
      const p = need(params.pane_id)
      if (p.control !== params.session) throw Object.assign(new Error('not attached'), { code: 'terminal_not_attached' })
      p.size = { cols: params.cols, rows: params.rows }
      return p.size
    },
    'e2e.term_detach': (params) => {
      const p = need(params.pane_id)
      if (p.control === params.session) p.control = null
      return {}
    },
    // What the specs look at: the pane's PTY size, and whether its terminal is held.
    'e2e.pane_size': (params) => {
      const p = need(params.pane_id)
      return { ...p.size, attached: Boolean(p.control) }
    },
    'plugin.list': () => ({ plugins }),
    // Installed plugins as plugin.list reports them (herdr-projects 0.2 or 1.x).
    'e2e.plugins': (params) => {
      plugins = Array.isArray(params.plugins) ? params.plugins : []
      return {}
    },
    'plugin.action.list': () => ({ actions: [] }),
  }

  async function answer(raw) {
    let req
    try { req = JSON.parse(raw) }
    catch { return { id: null, error: { code: 'bad_request', message: 'Invalid JSON' } } }
    const fn = methods[req.method]
    if (!fn) {
      log(`fake herdr: unknown method ${req.method}`)
      return { id: req.id, error: { code: 'unknown_method', message: `Unknown method ${req.method}` } }
    }
    try { return { id: req.id, result: await fn(req.params || {}) } }
    catch (e) { return { id: req.id, error: { code: e.code || 'internal', message: e.message } } }
  }

  try { fs.unlinkSync(sock) }
  catch { /* no stale socket */ }
  const server = net.createServer((conn) => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('error', () => {})
    conn.on('data', async (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      buf = ''
      const res = await answer(line)
      if (!conn.destroyed) conn.end(JSON.stringify(res) + '\n')
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(sock, () => resolve(server))
  })
}
