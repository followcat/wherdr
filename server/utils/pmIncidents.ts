// Agents gone: the facts read on herdr-core (its machines, the terminals'
// exit, the local core's start time) and the account's limit data, then the
// incidents shared/pm/incident.ts decides, recorded once per run.
import { diagnose, limitText, type GoneAgent, type Incident, type LimitAt, type MachineFacts, type TerminalFacts } from '../../shared/pm/incident'
import { accountQuota } from '../../shared/pm/pace'
import { LABEL, type LabelledTerminal, type Run } from '../../shared/pm/run'
import type { Quotas } from '../../shared/types'
import type { PmLaunchDeps } from './pmLaunch'

export type CoreTerminal = LabelledTerminal & TerminalFacts
export interface CoreList { terminals: CoreTerminal[], machines?: { name: string, state: string, since_ms?: number | null, why?: string | null }[] }
// quotas: the account readings (tests give their own).
export type IncidentDeps = PmLaunchDeps & { quotas?: () => Promise<Quotas> }

async function machineFacts(deps: IncidentDeps, list: CoreList, now: number): Promise<MachineFacts[]> {
  const status = await deps.call<{ uptime_ms?: number }>('server.status', {}, 8000).catch(() => null)
  // wherdr's agents still running on a machine: its terminals are `name/t7`, the local ones `t7`.
  const live = (local: boolean, name: string) => list.terminals.filter(t => t.state !== 'finished' && (local ? !t.address.includes('/') : t.address.startsWith(`${name}/`))).length
  return deps.machines().map((m): MachineFacts => {
    if (m.local) return { key: m.key, label: m.label, state: 'connected', live: live(true, ''), ...(typeof status?.uptime_ms === 'number' ? { coreStartedAt: now - status.uptime_ms } : {}) }
    const v = list.machines?.find(x => x.name === m.label)
    if (!v) return { key: m.key, label: m.label, state: m.status === 'online' ? 'connected' : m.status, why: m.error }
    return { key: m.key, label: m.label, state: v.state, since: v.since_ms, why: v.why, live: live(false, m.label) }
  })
}

export const readAccounts = (deps: IncidentDeps) => (deps.quotas ?? (async () => (await import('./quotas')).readQuotas()))().catch(() => null)
export const limitOf = (q: Quotas | null): LimitAt => (program, machine, at) => {
  if (!q) return null
  const account = q.accounts?.find(a => a.program === program && a.machines.includes(machine))
  const quota = account ? accountQuota(q, account) : program === 'claude' || program === 'codex' ? q[program] : null
  return limitText(quota, at)
}

// The incidents of these runs, whose agents are not running (none already recorded).
export async function recordGone(deps: IncidentDeps, runs: Run[], list: CoreList, now = Date.now()): Promise<Map<string, Incident>> {
  const byRun = new Map<string, Incident>()
  // A run already in an incident keeps it (seen while wherdr ran, then a restart).
  for (const i of await deps.store.incidents()) for (const id of i.runs) byRun.set(id, i)
  const fresh = runs.filter(r => !byRun.has(r.id))
  if (!fresh.length) return byRun
  const gone: GoneAgent[] = await Promise.all(fresh.map(async (run) => {
    const t = list.terminals.find(x => x.labels?.[LABEL.run] === run.id)
    if (!t || t.state !== 'finished') return { run }
    // An agent that ended on its own: the last lines it printed say why, when they do.
    const out = await deps.call<{ text?: string }>('terminal.read', { terminal: t.address, lines: 20 }, 3000).catch(() => null)
    return { run, terminal: { ...t, lastLines: String(out?.text ?? '') } }
  }))
  const ended = gone.some(g => g.terminal)
  const quotas = ended ? await readAccounts(deps) : null
  const added = await deps.store.addIncidents(diagnose(gone, await machineFacts(deps, list, now), limitOf(quotas), now))
  for (const i of added) for (const id of i.runs) byRun.set(id, i)
  for (const i of added) for (const id of i.tasks) {
    const task = await deps.store.task(id)
    const facts = i.evidence.filter(e => e.startsWith(`${id} `))
    if (task) await deps.store.logTask(task, 'engine', `incident ${i.id} on ${i.label}: ${i.cause} (${(facts.length ? facts : i.evidence).join('; ')})`)
  }
  return byRun
}
