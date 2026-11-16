// `wherdr alfred groups` and `wherdr alfred brief`: the home tabs with their
// projects, and the facts of a brief for one tab (the open one by default) or
// all, read from the engine (shared/pm/brief.ts), with no model call.
import { MAIN } from '../../shared/pm/coordinator'
import { projectFacts, quotaNear, BRIEF_DAY_MS } from '../../shared/pm/brief'
import { isOpen } from '../../shared/pm/incident'
import { shownKey, shownTaskId } from '../../shared/pm/projectKey'
import { projectScopes, resolveScope, scopeName } from '../../shared/notes'
import { readProjectTabs } from '../../shared/settings'
import type { MachineInfo, Quotas } from '../../shared/types'
import { parseStatusBlock } from '../../shared/statusBlock'
import type { CoreAdminDeps } from './coreCreate'
import { HerdrError } from './herdr'
import { homeTabs } from './notesStore'
import { memoryState } from './pmMemory'
import type { PmStore } from './pmStore'

export type BriefDeps = CoreAdminDeps & { store: PmStore, settingsFile?: string, quotas?: () => Promise<Quotas> }

// The tabs, the projects each one shows, and the tab the user has open.
async function scopes(deps: BriefDeps) {
  const machines = deps.machines(), { s, groups, label, tabs } = await homeTabs(deps.settingsFile, machines)
  const projects = await deps.store.projects(), overrides = readProjectTabs(s.projectTabs)
  const on = new Map(projects.map(p => [p.key, projectScopes(p, overrides[p.key], groups, tabs)]))
  const saved = (await deps.store.coordinator(MAIN))?.openTab
  const open = saved && (saved === 'all' || tabs.some(t => t.scope === saved)) ? saved : 'all'
  const name = (scope: string) => scopeName(scope, tabs, label)
  return { machines, tabs, projects, on, open, name }
}

export async function alfredGroups(deps: BriefDeps) {
  const { tabs, projects, on, open, name } = await scopes(deps)
  return {
    open: name(open),
    groups: tabs.map(t => ({ name: t.name, kind: t.scope.startsWith('machine:') ? 'machine' : 'group', projects: projects.filter(p => on.get(p.key)!.includes(t.scope)).map(shownKey) })),
  }
}

export async function alfredBrief(deps: BriefDeps, cmd: { group?: string, all?: true, since?: number }, now = Date.now()) {
  const { store } = deps
  const { machines, tabs, projects, on, open, name } = await scopes(deps)
  const picked = cmd.all ? 'all' : cmd.group ? resolveScope(cmd.group, tabs) : open
  if (typeof picked !== 'string') throw new HerdrError('bad_input', picked.error)
  const tab = tabs.find(t => t.scope === picked)
  const main = await store.coordinator(MAIN)
  const since = cmd.since ?? main?.briefs?.[picked] ?? now - BRIEF_DAY_MS
  const [tasks, incidents, coordinators] = [await store.tasks(), await store.incidents(), await store.coordinators()]
  const panes = deps.panes()
  const coordinatorState = (key: string) => {
    const c = coordinators.find(x => x.project === key)
    if (!c?.terminal) return 'not started'
    const pane = panes.find(p => p.coreAddress === c.terminal)
    return !pane ? 'stopped' : pane.status === 'idle' ? 'idle' : undefined
  }
  const shown = projects.filter(p => picked === 'all' || on.get(p.key)!.includes(picked)).map((p) => {
    const mine = tasks.filter(t => t.project === p.key)
    const facts = projectFacts(mine.map(t => ({ ...t, id: shownTaskId(projects, t.id) })), since, now)
    const open = incidents.filter(i => isOpen(i, mine))
    const coordinator = coordinatorState(p.key)
    return { project: shownKey(p), name: p.name, ...facts, ...(coordinator ? { coordinator } : {}), ...(open.length ? { incidents: open.map(i => ({ machine: i.label, cause: i.cause, tasks: i.tasks.map(id => shownTaskId(projects, id)) })) } : {}) }
  })
  // The scope's machines: offline, or every agent slot taken.
  const scoped = machines.filter(m => !tab || tab.machines.includes(m.baseKey ?? m.key))
  // Its status line names it by key, else by a label a status line reads (none: no line, its name only).
  const fact = (m: MachineInfo, state: string) => {
    const arg = m.key || m.label
    return { name: m.label, state, ...(parseStatusBlock(`status machine:${arg}`) ? { status: `machine:${arg}` } : {}) }
  }
  const machineFacts = (await Promise.all(scoped.map(async (m) => {
    if (m.status === 'offline') return fact(m, 'offline')
    const mem = await memoryState(deps, m.key).catch(() => null)
    return mem?.cap !== undefined && mem.agents >= mem.cap ? fact(m, 'full') : null
  }))).filter(x => x !== null)
  const q = await (deps.quotas ?? (async () => (await import('./quotas')).readQuotas()))().catch(() => null)
  const quotas = (['claude', 'codex'] as const).flatMap((program) => {
    const accounts = q?.[`${program}Accounts`]
    const list = accounts?.length ? accounts.map(a => ({ account: a.name ?? a.machines.map(x => x.label).join(', '), q: a })) : [{ q: q?.[program] ?? null }]
    return list.flatMap(({ q: one, ...rest }) => {
      const near = quotaNear(one, now)
      return near.length ? [{ status: `quota:${program}`, ...rest, near }] : []
    })
  })
  // The next brief of this scope starts here (one --since a date leaves it).
  const fresh = cmd.since ? undefined : await store.coordinator(MAIN)
  if (fresh) await store.saveCoordinator({ ...fresh, briefs: { ...fresh.briefs, [picked]: now } })
  return {
    scope: name(picked), open: name(open), since: new Date(since).toISOString(),
    projects: shown, machines: machineFacts, quotas,
    others: ['all', ...tabs.map(t => t.scope)].filter(s => s !== picked).map(name),
  }
}
