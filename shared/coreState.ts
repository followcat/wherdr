import { rowGroup, type Row } from './spaces'
import type { CoreTerminal } from './coreInventory'
import { type CoreDocs, SPACE_LABEL, TAB_LABEL, rootTerminals, SEEN_LABEL } from './coreLayout'
import { addressOnly, coreActivity, coreTitle, coreUnread, ownTitle } from './coreInventory'
import type { HerdrState, MachineInfo, Pane } from './types'
import { cleanTitle } from './paneTitle'

export interface CoreMachine { name: string; state: string; why?: string }
// Lossless encoding keeps IDs stable across inventory order and core restarts.
const key = (value: string) => Array.from(new TextEncoder().encode(value), b => b.toString(16).padStart(2, '0')).join('')
// Placement of a terminal, in this order: its herdr.space / herdr.tab labels, the tab
// of the machine's herdr-app document whose layout holds it, then its folder
// (one workspace per folder, one tab per terminal) when nothing says otherwise.
export function coreState(terminals: CoreTerminal[], machines: CoreMachine[], docs: CoreDocs = {}): HerdrState {
  const result: HerdrState = { ok: true, ready: true, workspaces: [], tabs: [], panes: [], machines: [
    { key: '', label: 'Local', local: true, status: 'online', error: null },
    ...machines.map((m): MachineInfo => ({ key: key(m.name), label: m.name, local: false,
      status: m.state === 'connected' ? 'online' : m.state === 'connecting' ? 'connecting' : 'offline', error: m.why ?? null })),
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
    const machine = machineName ? key(machineName) : ''
    if (machine && !result.machines!.some(m => m.key === machine)) result.machines!.push({ key: machine, label: machineName, local: false, status: 'offline', error: null })
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
    const tab = placed?.tab ? `${workspace}:b${key(placed.tab)}` : `${workspace}:t${id}`
    if (!result.workspaces.some(w => w.id === workspace)) {
      const folder = space?.folder || cwd
      result.workspaces.push({ id: workspace, machine, label: space?.name || folder.split('/').filter(Boolean).pop() || 'Terminals',
        path: folder, number: result.workspaces.length + 1, status: null, worktree: false, ...(placed ? { coreSpace: placed.space } : {}) })
    }
    const activity = coreActivity(terminal)
    const commands = [terminal.template, terminal.status?.app, ...(terminal.foreground?.argv ?? []), ...(terminal.argv ?? [])]
    const agent = terminal.agent || (commands.map(c => c?.split('/').pop()?.replace(/^claude-code$/, 'claude').replace(/^gemini-cli$/, 'gemini')).find(c => c && ['claude', 'codex', 'omp', 'devin', 'opencode', 'gemini', 'aider'].includes(c)) ?? null)
    if (!result.tabs!.some(t => t.id === tab)) {
      result.tabs!.push({ id: tab, workspace, machine, label: docTab?.name || coreTitle(terminal), number: result.tabs!.length + 1, layout: null })
      if (docTab) order.set(tab, space!.tabs!.indexOf(docTab))
    }
    const state = activity === 'error' ? 'blocked' : activity
    // idle after a turn nobody looked at yet = finished, unread ('done').
    const status = (state === 'idle' || state === 'done') && terminal.labels?.[SEEN_LABEL] !== undefined ? (coreUnread(terminal) ? 'done' : 'idle') : state
    const pane: Pane = { id: `${workspace}:p${id}`, coreAddress: terminal.address, machine, workspace, tab, tabLabel: result.tabs!.find(t => t.id === tab)!.label,
      agent, name: addressOnly(terminal.name, terminal.address) ? null : terminal.name ?? null, label: ownTitle(terminal), title: terminal.title == null ? null : cleanTitle(terminal.title), cwd, agentSession: null,
      status, interaction: 'unknown',
      ...(typeof terminal.status_ms === 'number' ? { stateSeq: terminal.status_ms } : terminal.turn ? { stateSeq: terminal.turn } : {}) }
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
