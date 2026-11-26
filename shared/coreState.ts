import { rowGroup, type Row } from './spaces'
import type { CoreTerminal } from './coreInventory'
import { type CoreDocs, SPACE_LABEL, TAB_LABEL, WHERDR_TAB_LABEL, rootTerminals, SEEN_LABEL } from './coreLayout'
import { addressOnly, coreActivity, coreTitle, coreUnread, ownTitle } from './coreInventory'
import type { HerdrState, MachineInfo, Pane } from './types'
import { cleanTitle, maskCreds } from './paneTitle'
import { LABEL } from './pm/run'
import { CODEX_UPDATED_LABEL, codexInstalling } from './codexLaunch'
import { canonicalCmdAgent, cmdProgramFromArgv } from './cmdAliases'

export interface CoreMachine { name: string; state: string; host?: string; why?: string }
export interface CoreStateOptions {
  localKey?: string
  localBaseKey?: string
  localStatus?: MachineInfo['status']
  localError?: string | null
  session?: string
  machineKey?: (name: string) => string
  machineBaseKey?: (m: CoreMachine) => string | undefined
}
// Lossless encoding keeps IDs stable across inventory order and core restarts.
const key = (value: string) => Array.from(new TextEncoder().encode(value), b => b.toString(16).padStart(2, '0')).join('')
const KNOWN_AGENTS = ['claude', 'codex', 'omp', 'devin', 'opencode', 'gemini', 'aider', 'agy', 'cline', 'hermes']
const baseName = (c: string | null | undefined) => c?.split('/').pop() || undefined
const canonical = (s: string) => s.replace(/^claude-code$/, 'claude').replace(/^gemini-cli$/, 'gemini')
  .replace(/^antigravity(?:-cli)?$/, 'agy')
// Core's agent field is an opaque kind, not an argv path: known aliases are
// normalized, an unknown "custom/tool" stays exactly as declared.
const canonicalAgent = (c: string | null | undefined) => (c ? canonicalCmdAgent(c) ?? canonical(c) : undefined)
const commandAgent = (c: string | null | undefined) => {
  const name = baseName(c)
  return name ? canonicalCmdAgent(name) ?? canonical(name) : undefined
}
// The launch template and the app a status reports declare a kind too: a bare
// `cmd` there is Command Code, while the same word inside a command line below
// never is.
const declaredAgent = (c: string | null | undefined) => {
  const name = commandAgent(c)
  return name && (KNOWN_AGENTS.includes(name) || name === 'cmd') ? name : null
}
// Placement of a terminal, in this order: its herdr.space / herdr.tab labels, the tab
// of the machine's herdr-app document whose layout holds it, then its folder
// (one workspace per folder, one tab per terminal, or one tab per wherdr.tab
// label: a split of a folder tab) when nothing says otherwise.
// `host`: the name of the machine wherdr runs on (its host name, or the one the user gave it).
export function coreState(terminals: CoreTerminal[], machines: CoreMachine[], docs: CoreDocs = {}, host = '', options: CoreStateOptions = {}): HerdrState {
  const localKey = options.localKey ?? ''
  const machineKey = options.machineKey ?? key
  const sessionFields = options.session !== undefined ? { session: options.session } : {}
  const result: HerdrState = { ok: true, ready: true, workspaces: [], tabs: [], panes: [], machines: [
    { key: localKey, ...(options.localBaseKey !== undefined ? { baseKey: options.localBaseKey } : {}), ...sessionFields, label: host, local: true,
      status: options.localStatus ?? 'online', error: options.localError ?? null },
    ...machines.map((m): MachineInfo => {
      const baseKey = options.machineBaseKey?.(m)
      return {
        key: machineKey(m.name),
        ...(baseKey !== undefined ? { baseKey } : {}),
        ...sessionFields,
        label: m.name,
        local: false,
        status: m.state === 'connected' ? 'online' : m.state === 'connecting' ? 'connecting' : 'offline',
        error: m.why ?? null,
      }
    }),
  ] }
  const held = new Map<string, { space: string; tab: string }>()
  for (const [machineName, doc] of Object.entries(docs)) {
    for (const space of doc?.spaces ?? []) for (const tab of space.tabs ?? []) {
      for (const address of rootTerminals(tab.root)) held.set(`${machineName}/${address.split('/').pop()}`, { space: space.id, tab: tab.id })
    }
  }
  const order = new Map<string, number>() // tab id -> position in its document
  for (const terminal of terminals) {
    const machineName = terminal.address.includes('/') ? terminal.address.split('/')[0]! : ''
    const machine = machineName ? machineKey(machineName) : localKey
    if (machineName && !result.machines!.some(m => m.key === machine)) result.machines!.push({ key: machine, ...sessionFields, label: machineName, local: false, status: 'offline', error: null })
    const prefix = machine ? `${machine}~` : ''
    const cwd = terminal.cwd || ''
    const local = terminal.address.split('/').pop()!
    const placed = terminal.labels?.[SPACE_LABEL]
      ? { space: terminal.labels[SPACE_LABEL]!, tab: terminal.labels[TAB_LABEL] }
      : held.get(`${machineName}/${local}`)
    const space = placed ? docs[machineName]?.spaces?.find(s => s.id === placed.space) : undefined
    const docTab = space?.tabs?.find(t => t.id === placed?.tab)
    const workspace = placed ? `${prefix}s${key(placed.space)}` : `${prefix}w${key(cwd || terminal.address)}`
    const id = key(terminal.address)
    const own = terminal.labels?.[WHERDR_TAB_LABEL]
    const tab = placed?.tab ? `${workspace}:b${key(placed.tab)}` : own ? `${workspace}:g${key(own)}` : `${workspace}:t${id}`
    if (!result.workspaces.some(w => w.id === workspace)) {
      const folder = space?.folder || cwd
      result.workspaces.push({ id: workspace, machine, label: maskCreds(space?.name || folder.split('/').filter(Boolean).pop() || 'Terminals'),
        path: folder, number: result.workspaces.length + 1, status: null, worktree: false, ...(placed ? { coreSpace: placed.space } : {}) })
    }
    const activity = coreActivity(terminal)
    const commands = [terminal.template, terminal.status?.app, ...(terminal.foreground?.argv ?? []), ...(terminal.argv ?? [])]
    // Codex exited after updating itself: a shell now, kept for its restart card.
    const updated = Boolean(terminal.labels?.[CODEX_UPDATED_LABEL]) && !terminal.agent
    const agent = updated ? 'codex'
      : canonicalAgent(terminal.agent)
        ?? declaredAgent(terminal.template) ?? declaredAgent(terminal.status?.app)
        ?? cmdProgramFromArgv(terminal.foreground?.argv) ?? cmdProgramFromArgv(terminal.argv)
        ?? (commands.map(commandAgent).find(c => c && KNOWN_AGENTS.includes(c)) ?? null)
    if (!result.tabs!.some(t => t.id === tab)) {
      result.tabs!.push({ id: tab, workspace, machine, label: maskCreds(docTab?.name || coreTitle(terminal)), ...(docTab?.name ? { docName: true as const } : {}), number: result.tabs!.length + 1, layout: null })
      if (docTab) order.set(tab, space!.tabs!.indexOf(docTab))
    }
    const state = activity === 'error' ? 'blocked' : activity
    // idle after a turn nobody looked at yet = finished, unread ('done').
    const status = updated ? 'blocked' : (state === 'idle' || state === 'done') && terminal.labels?.[SEEN_LABEL] !== undefined ? (coreUnread(terminal) ? 'done' : 'idle') : state
    const pane: Pane = { id: `${workspace}:p${id}`, coreAddress: terminal.address, machine, workspace, tab, tabLabel: result.tabs!.find(t => t.id === tab)!.label,
      agent, name: addressOnly(terminal.name, terminal.address) ? null : maskCreds(terminal.name) || null, label: maskCreds(ownTitle(terminal)) || null, title: terminal.title == null ? null : cleanTitle(terminal.title), cwd, agentSession: null,
      status, interaction: 'unknown', ...(terminal.labels && Object.keys(terminal.labels).length ? { labels: { ...terminal.labels } } : {}), ...(terminal.labels?.[LABEL.task] ? { task: terminal.labels[LABEL.task], ...(terminal.labels[LABEL.role] ? { role: terminal.labels[LABEL.role] } : {}) } : {}),
      ...(terminal.labels?.['wherdr.coordinator'] !== undefined ? { coordinator: true } : {}),
      ...(terminal.labels?.['backlot.role'] ? { backlotRole: terminal.labels['backlot.role'] } : {}),
      ...(terminal.labels?.['backlot.studio'] ? { backlotStudio: terminal.labels['backlot.studio'] } : {}),
      ...(updated ? { stopped: { reason: 'update' as const } } : agent === 'codex' && codexInstalling(terminal.title, terminal.status?.msg) ? { installing: true } : {}),
      ...(typeof terminal.status_ms === 'number' ? { stateSeq: terminal.status_ms, since: terminal.status_ms } : terminal.turn ? { stateSeq: terminal.turn } : {}) }
    result.panes.push(pane)
  }
  // Tabs follow their document's order inside a space, then renumber from 1.
  const index = new Map(result.tabs!.map((t, i) => [t.id, i]))
  const space = new Map(result.workspaces.map((w, i) => [w.id, i]))
  result.tabs!.sort((a, b) => space.get(a.workspace)! - space.get(b.workspace)! || (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6) || index.get(a.id)! - index.get(b.id)!)
  const count = new Map<string, number>()
  for (const t of result.tabs!) t.number = count.set(t.workspace, (count.get(t.workspace) ?? 0) + 1).get(t.workspace)!
  return result
}

// Core counters count the same workspace (or individual) rows as the headings.
export function coreRowCounts(rows: Row[], keep: (row: Row) => boolean = () => true) {
  const counts = { blocked: 0, working: 0, ready: 0 }
  // Rows without a status (plain shells) count as Ready, as in v2.5.
  for (const row of rows) if (keep(row)) { const g = rowGroup(row); counts[g === 'unknown' ? 'ready' : g]++ }
  return counts
}
