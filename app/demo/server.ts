// In-browser stand-in for wherdr's server in the demo build: answers the
// app's /api/* calls and feeds the live state, from scenario.ts. Nothing here
// talks to a network or runs a command; agents "answer" with scripted turns.
import type { ChatItem, HerdrState, Pane, QueuedMessage } from '#shared/types'
import { dividers, resizePreview } from '../../shared/layout'
import { applySettingsPatch, cleanSettingsPatch, type SettingsMap } from '../../shared/settings'
import * as S from './scenario'

export const DEMO_REFUSAL = 'Demo — nothing runs here. Install wherdr to drive your own agents.'

export interface DemoReply { status: number, body: unknown }
export interface DemoClock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
}

interface Chat { items: ChatItem[], v: number }
type Listener = () => void

const ok = (body: unknown = { ok: true }): DemoReply => ({ status: 200, body })
const fail = (status: number, error: string, code = 'demo'): DemoReply => ({ status, body: { error, code } })

export class DemoServer {
  private panes: Pane[]
  private workspaces = S.workspaces()
  private tabs = S.tabs()
  private chats = new Map<string, Chat>()
  private listeners = new Set<Listener>()
  private chatListeners = new Set<(pane: string) => void>()
  private viewing: string | null = null
  private turns = new Map<string, number>()
  private sent = 0
  private pending = new Map<string, { token: number, turn: S.ScriptedTurn }>()
  // Messages typed while a question hides the agent's input field: held, like
  // the real server does (server/utils/queued.ts), until the agent rests.
  private held = new Map<string, QueuedMessage[]>()
  private heldSeq = 0
  private nextWs = 5
  private seq = 10
  private settings: SettingsMap = {}
  private interactive = new Map<string, { cursor: number, details: boolean }>()

  interactiveScreen(id: string): string | null {
    const menu = this.interactive.get(id)
    if (!menu) return null
    return menu.details
      ? 'Usage history\n\nDemo analytics · no account data\n\nesc back'
      : ['Usage', '', `${menu.cursor === 0 ? '›' : ' '} 1. View analytics  Usage history`, `${menu.cursor === 1 ? '›' : ' '} 2. Redeem reset    Check availability`, '', 'enter open · esc back'].join('\n')
  }

  terminalKeys(id: string, keys: string[]): boolean {
    const menu = this.interactive.get(id)
    if (!menu) return false
    for (const key of keys) {
      if (key === 'up' || key === '1') menu.cursor = 0
      if (key === 'down' || key === '2') menu.cursor = 1
      if (key === 'enter') menu.details = true
      if (key === 'esc') {
        if (menu.details) menu.details = false
        else { this.interactive.delete(id); this.update(id, { interaction: 'input' }); return true }
      }
    }
    this.update(id, { interaction: 'terminal' })
    return true
  }

  constructor(private clock: DemoClock = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms) }) {
    const now = clock.now()
    this.panes = S.panes(now)
    for (const [id, items] of Object.entries(S.conversations(now))) this.chats.set(id, { items, v: 1 })
    this.finishCodex()
  }

  // ---------------------------------------------------------------- live state
  state(): HerdrState {
    return { ok: true, ready: true, workspaces: this.workspaces, tabs: this.tabs, panes: this.panes.map(p => ({ ...p })) }
  }

  onState(fn: Listener) {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  onChat(fn: (pane: string) => void) {
    this.chatListeners.add(fn)
    return () => { this.chatListeners.delete(fn) }
  }

  pane(id: string) { return this.panes.find(p => p.id === id) }
  chat(id: string) { return this.chats.get(id)?.items || [] }

  // The app says which pane is on screen: a finished agent seen there is read.
  setViewing(pane: string | null, visible: boolean) {
    this.viewing = visible ? pane : null
    const p = this.viewing ? this.pane(this.viewing) : undefined
    if (p?.status === 'done') this.update(p.id, { status: 'idle' })
  }

  private emit() { for (const fn of this.listeners) fn() }

  private update(id: string, patch: Partial<Pane>) {
    const i = this.panes.findIndex(p => p.id === id)
    if (i < 0) return
    const next = { ...this.panes[i]!, ...patch }
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as Record<string, unknown>)[k]
    if (patch.status && patch.status !== this.panes[i]!.status) next.stateSeq = ++this.seq
    this.panes[i] = next
    this.emit()
  }

  private push(id: string, item: ChatItem) {
    const c = this.chats.get(id) || { items: [], v: 0 }
    c.items = [...c.items, { ...item, ts: item.ts || new Date(this.clock.now()).toISOString() }]
    c.v++
    this.chats.set(id, c)
    for (const fn of this.chatListeners) fn(id)
  }

  // End of a turn: read right away when watched, otherwise "done" (unread).
  private finish(id: string) {
    this.update(id, { status: this.viewing === id ? 'idle' : 'done', activity: undefined, ompActivity: undefined, prompt: undefined })
    this.deliverHeld(id)
  }

  // ---------------------------------------------------------------- held messages
  private setHeld(id: string, list: QueuedMessage[]) {
    if (list.length) this.held.set(id, list)
    else this.held.delete(id)
    this.update(id, { queued: list.length ? list : undefined })
  }

  // `clientId`: the app's id for the bubble it already shows (app/utils/outbox.ts).
  private hold(id: string, text: string, clientId?: string): DemoReply {
    const list = this.held.get(id) || []
    const own = clientId && /^w-[a-z0-9]{1,32}$/.test(clientId) && !list.some(q => q.id === clientId) ? clientId : null
    const q: QueuedMessage = { id: own || `demo-q${++this.heldSeq}`, text: text.slice(0, 4000), at: this.clock.now(), state: 'held' }
    // Listed in the pane's state (sent before this answer) and not returned
    // here: the app would keep its own copy of a returned record for a while
    // (app/utils/outbox.ts), still shown after a Cancel.
    this.setHeld(id, [...list, q])
    return ok()
  }

  // The agent rests with its input field back: the oldest held message goes
  // out; the next one follows at the end of that turn.
  private deliverHeld(id: string) {
    if (!this.held.has(id)) return
    this.clock.setTimeout(() => {
      const p = this.pane(id)
      const [next, ...rest] = this.held.get(id) || []
      if (!p || !next || p.status === 'working' || p.status === 'blocked') return
      this.setHeld(id, rest)
      this.send(p, next.text)
    }, 600)
  }

  unqueue(id: string, text: string, msgId?: string): DemoReply {
    const list = this.held.get(id) || []
    const mine = list.find(q => q.id === msgId) || list.find(q => q.text === text)
    if (!mine) return fail(409, 'Already read by the agent', 'already_read')
    this.setHeld(id, list.filter(q => q !== mine))
    return ok({ ok: true, text: mine.text })
  }

  // Nothing fails to send here: a held message is still waiting, as asked.
  requeue(id: string, msgId: string): DemoReply {
    const mine = (this.held.get(id) || []).find(q => q.id === msgId)
    return mine ? ok({ ok: true, queued: mine }) : fail(404, 'Message not found', 'not_found')
  }

  private working(p: Pane, step: string) {
    if (p.agent === 'omp') return { status: 'working' as const, ompActivity: { step, since: this.clock.now() } }
    return { status: 'working' as const, activity: step }
  }

  // The Codex thread is mid-task when the demo opens: it finishes by itself.
  private finishCodex() {
    let at = 0
    for (const step of S.CODEX_FINISH) {
      at += step.after
      this.clock.setTimeout(() => {
        if (step.item) this.push(S.CODEX, step.item)
        if (step.activity) this.update(S.CODEX, { activity: step.activity })
        if (step.item?.role === 'assistant') this.finish(S.CODEX)
      }, at)
    }
    this.update(S.CODEX, { activity: 'Editing files' })
  }

  // ---------------------------------------------------------------- turns
  prompt(id: string, text: string, clientId?: string): DemoReply {
    const p = this.pane(id)
    if (!p) return fail(404, 'Pane not found', 'bad_pane')
    if (!text.trim()) return fail(400, 'Empty message', 'empty')
    if (!p.agent) return fail(400, DEMO_REFUSAL)
    if (text.trim().startsWith('/')) {
      this.push(id, { role: 'user', text, ts: null })
      if (text.trim() === '/usage' && p.agent === 'codex') {
        this.interactive.set(id, { cursor: 0, details: false })
        this.update(id, { interaction: 'terminal', status: 'idle' })
        return ok()
      }
      this.push(id, { role: 'system', text: `${text.trim().split(/\s/)[0]} — commands do not run in the demo`, ts: null })
      return ok()
    }
    // A question is open (or an earlier message still waits): typed now, the
    // message would be lost in it. Held, and sent once the agent rests.
    if (p.status === 'blocked' || this.held.has(id)) return this.hold(id, text, clientId)
    return this.send(p, text)
  }

  private send(p: Pane, text: string): DemoReply {
    const id = p.id
    this.push(id, { role: 'user', text, ts: null })
    const turn = S.scriptFor(p.agent || '', text, this.sent++)
    const token = (this.turns.get(id) || 0) + 1
    this.turns.set(id, token)
    this.update(id, this.working(p, 'Thinking'))
    const live = () => this.turns.get(id) === token
    let at = 900
    if (turn.thinking && p.agent !== 'codex') {
      const thought = turn.thinking
      this.clock.setTimeout(() => { if (live()) this.push(id, { role: 'thinking', text: thought, ts: null, ms: 1800 }) }, at)
      at += 1200
    }
    if (turn.approval) {
      const command = turn.approval
      this.clock.setTimeout(() => {
        if (!live()) return
        this.pending.set(id, { token, turn })
        this.update(id, { status: 'blocked', activity: undefined, ompActivity: undefined, prompt: p.agent === 'omp' ? S.approval(command) : claudeLike(command) })
      }, at)
      return ok()
    }
    this.playSteps(id, token, turn, at)
    return ok()
  }

  private playSteps(id: string, token: number, turn: S.ScriptedTurn, start: number) {
    const live = () => this.turns.get(id) === token
    let at = start
    for (const step of turn.steps) {
      this.clock.setTimeout(() => {
        if (!live()) return
        const p = this.pane(id)
        if (p) this.update(id, this.working(p, step.text))
        this.push(id, { role: 'tool', name: step.name, text: step.text, ts: null, ...(step.omp ? { omp: step.omp } : {}) })
      }, at)
      at += 1300
    }
    this.clock.setTimeout(() => {
      if (!live()) return
      this.push(id, { role: 'assistant', text: turn.reply, ts: null })
      this.finish(id)
    }, at + 600)
  }

  choose(id: string, index: number, label: string): DemoReply {
    const p = this.pane(id)
    if (!p?.prompt) return fail(409, 'The question has changed — check the current screen.', 'stale')
    const option = p.prompt.options[index]
    if (!option || option.label !== label) return fail(409, 'The question has changed — check the current screen.', 'stale')
    const pending = this.pending.get(id)
    this.pending.delete(id)
    const yes = index !== p.prompt.options.length - 1
    // The approval the demo opens with: omp's test run.
    if (!pending) {
      this.update(id, { prompt: undefined, ...this.working(p, 'npm test -- export.spec.ts --repeat 20') })
      const token = (this.turns.get(id) || 0) + 1
      this.turns.set(id, token)
      this.playSteps(id, token, yes
        ? { steps: [], reply: 'The spec passed **20 runs in a row** (it failed 2 out of 20 before the fix). Ready for review: one line changed in `src/export/csv.ts`.', denied: '' }
        : { steps: [], reply: 'OK, I did not run it. The fix is in place; run the spec when you want to confirm it.', denied: '' }, 1600)
      // The command already shown as running gets its result.
      if (yes) {
        this.clock.setTimeout(() => {
          const c = this.chats.get(id)!
          const i = c.items.findLastIndex(it => it.role === 'tool' && it.text === 'npm test -- export.spec.ts --repeat 20')
          if (i < 0) return
          c.items = c.items.with(i, { ...c.items[i]!, omp: { title: 'Bash', target: 'npm test -- export.spec.ts --repeat 20', exit: 0, ms: 14200, out: ' Test Files  20 passed (20)\n      Tests  240 passed (240)', outLines: 2 } })
          c.v++
          for (const fn of this.chatListeners) fn(id)
        }, 900)
      }
      return ok()
    }
    this.update(id, { prompt: undefined, ...this.working(p, 'Thinking') })
    if (yes) this.playSteps(id, pending.token, pending.turn, 500)
    else this.playSteps(id, pending.token, { steps: [], reply: pending.turn.denied, denied: '' }, 500)
    return ok()
  }

  interrupt(id: string): DemoReply {
    const p = this.pane(id)
    if (!p?.agent) return fail(400, 'No agent in this pane', 'bad_pane')
    const stopped = p.status === 'working' || p.status === 'blocked'
    this.turns.set(id, (this.turns.get(id) || 0) + 1)
    this.pending.delete(id)
    if (stopped) {
      this.push(id, { role: 'system', text: 'Interrupted', ts: null })
      this.update(id, { status: 'idle', activity: undefined, ompActivity: undefined, prompt: undefined })
      this.deliverHeld(id)
    }
    return ok({ ok: true, stopped, background: 0 })
  }

  // New agent from the "New" sheet: a new space, ready for a first message.
  newAgent(b: { kind?: string, cwd?: string, name?: string, prompt?: string }): DemoReply {
    const kind = ['claude', 'codex', 'omp'].includes(b.kind || '') ? b.kind! : 'claude'
    const n = this.nextWs++
    const ws = `w${n}`
    const id = `${ws}:p1`
    const cwd = b.cwd || `${S.HOME}/code/acme-web`
    this.workspaces = [...this.workspaces, { id: ws, label: b.name || cwd.split('/').pop() || kind, number: n, status: null, worktree: false }]
    this.tabs = [...this.tabs, { id: `${ws}:t1`, workspace: ws, label: '1', number: 1, layout: { tab: `${ws}:t1`, workspace: ws, zoomed: false, focused: id, area: { x: 0, y: 0, width: 160, height: 48 }, panes: [{ pane: id, rect: { x: 0, y: 0, width: 160, height: 48 } }], splits: [] } }]
    this.panes = [...this.panes, { id, workspace: ws, tab: `${ws}:t1`, tabLabel: null, agent: kind, name: b.name || null, label: null, status: 'idle', title: null, cwd, agentSession: `demo-${id}`, model: S.MODELS[kind], bornAt: this.clock.now(), stateSeq: ++this.seq }]
    this.chats.set(id, { items: [], v: 1 })
    this.emit()
    if (b.prompt?.trim()) this.prompt(id, b.prompt)
    return ok({ ok: true, pane_id: id })
  }

  close(id: string): DemoReply {
    const p = this.pane(id)
    if (!p) return fail(404, 'Pane not found', 'bad_pane')
    this.turns.set(id, (this.turns.get(id) || 0) + 1)
    this.held.delete(id)
    this.panes = this.panes.filter(x => x.id !== id)
    if (!this.panes.some(x => x.workspace === p.workspace)) {
      this.workspaces = this.workspaces.filter(w => w.id !== p.workspace)
      this.tabs = this.tabs.filter(t => t.workspace !== p.workspace)
    } else {
      this.tabs = this.tabs.map(t => (t.layout && t.layout.panes.some(x => x.pane === id)
        ? { ...t, layout: { ...t.layout, focused: null, splits: [], panes: t.layout.panes.filter(x => x.pane !== id).map(x => ({ ...x, rect: t.layout!.area })) } }
        : t))
    }
    this.emit()
    return ok()
  }

  // ---------------------------------------------------------------- HTTP
  handle(method: string, url: string, body: Record<string, unknown> = {}): DemoReply {
    const u = new URL(url, 'http://demo.invalid')
    const q = u.searchParams
    const path = u.pathname
    const paneId = String(q.get('pane') || body.pane_id || '')
    const now = this.clock.now()
    if (method === 'GET') {
      switch (path) {
        case '/api/auth/status': return ok({ enabled: false, unlocked: true, devices: [] })
        case '/api/config': return ok({ kinds: ['claude', 'codex', 'omp'], home: S.HOME, os: 'Darwin', dirs: [`${S.HOME}/code/acme-api`, `${S.HOME}/code/acme-web`], push: { enabled: false, key: null, devices: 0 } })
        case '/api/onboarding': return ok({ done: true })
        case '/api/quotas': return ok(S.quotas(now))
        case '/api/machine/order': return ok({ order: [] })
        case '/api/settings': return ok({ settings: this.settings })
        case '/api/sessions': return ok({ sessions: [] })
        case '/api/worktrees': return ok({ worktrees: [] })
        case '/api/plugins/actions': return ok({ actions: [] })
        case '/api/push/quiet': return ok({})
        case '/api/push/devices': return ok({ devices: [] })
        case '/api/close/status': return ok({ git: false })
        case '/api/isgit': return ok({ git: false })
        case '/api/efforts': return ok({ levels: ['low', 'medium', 'high'], current: this.pane(paneId)?.model?.effort || null })
        case '/api/commands': return ok({ commands: S.COMMANDS[this.pane(paneId)?.agent || ''] || [] })
        case '/api/models': return this.models(paneId)
        case '/api/chat': return this.chatReply(paneId, q.get('since'), q.get('before'))
        case '/api/changes': return S.CHANGES[paneId] ? ok(S.CHANGES[paneId]) : ok({ git: false })
        case '/api/files': return ok(q.get('path') === 'src'
          ? { root: `${S.HOME}/code/acme-web`, path: 'src', truncated: false, entries: [
              { name: 'main.ts', kind: 'file', size: 236, link: false },
            ] }
          : { root: `${S.HOME}/code/acme-web`, path: '', truncated: false, entries: [
              { name: 'src', kind: 'dir', size: null, link: false },
              { name: '.gitignore', kind: 'file', size: 24, link: false },
              { name: 'package.json', kind: 'file', size: 412, link: false },
              { name: 'README.md', kind: 'file', size: 88, link: false },
            ] })
        case '/api/files/read': return fail(404, DEMO_REFUSAL)
        case '/api/screen': return ok({ text: this.interactiveScreen(paneId) || '', tabs: null, tab: null, interaction: this.pane(paneId)?.interaction })
        case '/api/search': return ok(this.search(String(q.get('q') || '')))
        case '/api/dirs': return ok({ path: S.HOME, parent: null, home: S.HOME, dirs: [
          { name: 'acme-api', path: `${S.HOME}/code/acme-api`, git: true },
          { name: 'acme-web', path: `${S.HOME}/code/acme-web`, git: true },
        ] })
        case '/api/tasks': return this.tasks(q.get('since'))
        case '/api/tasks/links': {
          const l = S.boardLinks(this.clock.now(), { codex: this.pane(S.CODEX)?.status || 'done', omp: this.pane(S.OMP)?.status || 'done' })
          return q.get('since') === l.version ? ok({ same: true, version: l.version }) : ok(l)
        }
        // Start's agent: the built-in default and the demo's agents (Start itself stays refused).
        case '/api/tasks/start': return ok({ agent: { value: 'claude', kind: 'claude', place: 'builtin', from: 'built in' }, agents: ['claude', 'codex', 'omp'] })
        case '/api/tasks/details': {
          const t = this.tasksBoard().machines[0]!.tasks.find(x => x.id === q.get('id'))
          return t ? ok(S.taskDetails(t)) : fail(404, 'Task not found', 'bad_task')
        }
      }
      return fail(404, DEMO_REFUSAL)
    }
    switch (path) {
      // Settings stay in this page (nothing is stored outside the browser).
      case '/api/settings': {
        const patch = cleanSettingsPatch(body.settings)
        if (!patch) return fail(400, 'Invalid settings', 'bad_settings')
        this.settings = applySettingsPatch(this.settings, patch, body.migrate === true).next
        return ok({ settings: this.settings })
      }
      case '/api/space': {
        // A demo divider changes only the in-memory layout, never a real pane.
        if (body.op !== 'layout.ratio') return fail(403, DEMO_REFUSAL)
        const tab = this.tabs.find(t => t.id === body.tab_id)
        const ratio = body.ratio
        if (!tab?.layout || typeof body.path !== 'string' || typeof ratio !== 'number'
          || !Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9
          || !dividers(tab.layout).some(d => d.path === body.path)) return fail(400, 'Invalid split')
        const layout = resizePreview(tab.layout, body.path, ratio)
        this.tabs = this.tabs.map(t => t === tab ? { ...t, layout } : t)
        this.emit()
        return ok()
      }
      case '/api/prompt': return this.prompt(paneId, String(body.text || ''), typeof body.client_id === 'string' ? body.client_id : undefined)
      // The app types a written reply to Claude's or Codex's question (see
      // shared/sendRoute.ts): here it never answers the question in the
      // visitor's place, it waits like any message sent while one is open.
      case '/api/input': return this.terminalKeys(paneId, Array.isArray(body.keys) ? body.keys as string[] : []) ? ok()
        : typeof body.text === 'string' && body.text.trim() && this.pane(paneId)?.agent ? this.prompt(paneId, body.text) : fail(403, DEMO_REFUSAL)
      case '/api/unqueue': return this.unqueue(paneId, String(body.text || ''), typeof body.id === 'string' ? body.id : undefined)
      case '/api/requeue': return this.requeue(paneId, String(body.id || ''))
      case '/api/choose': return this.choose(paneId, Number(body.index), String(body.label || ''))
      case '/api/interrupt': return this.interrupt(paneId)
      case '/api/agents': return this.newAgent(body as Parameters<DemoServer['newAgent']>[0])
      case '/api/close': return this.close(paneId)
      case '/api/seen': {
        const p = this.pane(paneId)
        if (p && (p.status === 'done' || p.status === 'idle')) this.update(paneId, { status: body.read ? 'idle' : 'done' })
        return ok()
      }
      case '/api/rename': {
        this.update(paneId, { label: String(body.label || '') || null })
        return ok()
      }
      case '/api/model': {
        const p = this.pane(paneId)
        if (p?.model) this.update(paneId, { model: { ...p.model, label: String(body.label || p.model.label) } })
        return ok()
      }
      case '/api/effort': {
        const p = this.pane(paneId)
        if (p?.model) this.update(paneId, { model: { ...p.model, effort: String(body.level || '') } })
        return ok()
      }
      case '/api/dismiss': case '/api/push/unsubscribe': case '/api/sessions': return ok()
      case '/api/onboarding': return ok()
    }
    return fail(403, DEMO_REFUSAL)
  }

  private chatReply(id: string, since: string | null, before: string | null): DemoReply {
    const p = this.pane(id)
    if (!p) return fail(404, 'Pane not found', 'bad_pane')
    const c = this.chats.get(id)
    if (!p.agent || !c) return ok({ available: false, reason: 'unsupported' })
    const token = `demo-${c.v}`
    if (before !== null) return ok({ available: true, file: `demo-${id}`, token, items: [], start: 0, older: true })
    if (since === token) return ok({ available: true, unchanged: true, token })
    return ok({ available: true, file: `demo-${id}`, session: `demo-${id}`, token, items: c.items, start: 0, queue: [], model: p.model || null })
  }

  private models(id: string): DemoReply {
    const p = this.pane(id)
    if (!p?.agent) return fail(404, 'Pane not found', 'bad_pane')
    const current = p.model?.label
    return ok({ agent: p.agent, at: this.clock.now(), options: (S.MODEL_OPTIONS[p.agent] || []).map((label, i) => ({ label, hint: null, current: label === current, isDefault: i === 0 })) })
  }

  // The Board: the demo's herdr-projects 1.x tasks (scenario.ts). Telling or
  // approving would reach a real agent: refused like every other write.
  private tasksBoard() {
    return S.tasks({ codex: this.pane(S.CODEX)?.status || 'done', omp: this.pane(S.OMP)?.status || 'done' })
  }

  private tasks(since: string | null): DemoReply {
    const b = this.tasksBoard()
    return since === b.version ? ok({ same: true, version: b.version }) : ok(b)
  }

  private search(text: string) {
    const needle = text.trim().toLowerCase()
    if (needle.length < 2) return { hits: [], limited: false }
    const hits = []
    for (const p of this.panes) {
      const items = this.chats.get(p.id)?.items || []
      for (const [offset, it] of items.entries()) {
        const at = it.text.toLowerCase().indexOf(needle)
        if (at < 0 || (it.role !== 'user' && it.role !== 'assistant')) continue
        hits.push({ pane: p.id, agent: p.agent || '', title: p.label || p.name || p.cwd?.split('/').pop() || p.id, role: it.role, text: it.text, excerpt: it.text.slice(Math.max(0, at - 60), at + 120), ts: it.ts, offset })
      }
    }
    return { hits, limited: false }
  }
}

// Claude Code's permission question for a shell command.
function claudeLike(command: string): NonNullable<Pane['prompt']> {
  return {
    question: 'Do you want to proceed?',
    cursor: 0,
    options: [{ label: 'Yes', hint: null }, { label: `Yes, and don’t ask again for ${command.split(' ')[0]} commands`, hint: null }, { label: 'No', hint: null }],
    detail: { tool: 'Bash', command, description: 'Run a command' },
  }
}
