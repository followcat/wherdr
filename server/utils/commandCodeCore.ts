// Machine-scoped Command Code conversation locator, for the A5 display-only
// session fallback. One helper instance per machine (exec + home): it turns a
// LIVE core terminal detail (root pid + recorded argv + foreground pid) into
// the conversation the terminal most probably shows, by composing the bounded
// machine census (agentCensus), metadata discovery (cmdFiles), the cached
// header source (createCmdHeaders) and the pure selector (cmdSelect).
//
// Ownership is fail-closed. Target = a proven foreground cmd PID, else the
// root PID itself, else exactly one DIRECT cmd child of root. A root PID that
// IS a cmd process must additionally have recorded launch argv proving a cmd
// launch — an old shell that exec'd cmd keeps its older start ticks, which
// cannot bound the agent's birth (cmdLaunchArgs). The same exec gap exists
// for EVERY non-root target (foreground or direct child): nothing records
// exec time, so the strict birth bound there is the first machine wall at
// which this generation (pid+startTicks) was sampled as a classified cmd
// row — the census record's own observedAt, never the coordinator clock,
// which is not in the remote mtime epoch. Missing/unreliable observation:
// unavailable, no local-clock fallback. AVAILABILITY: a child session saved
// before our first observation (or after an app restart/eviction re-arms
// it) stays unavailable until its NEXT persisted write — an additional
// conservative wait on top of the first-assistant-flush rule.
// Deeper wrappers are unproven: the census only carries cmd rows, so a
// non-direct ancestry chain can never be established. Process
// cwd/startTicks/birth come from the census row alone — never
// pane.cwd/created_ms — and two same-cwd cmd peers refuse before any file
// IO. Seed argv is only the recorded root argv (root-equal target,
// launch-exact by definition) or a census row's argvExact-sampled argv; a
// full-UUID seed must be unique across the WHOLE basename catalog including
// pre-birth entries, or it is omitted before cmdSelect.
//
// Evidence coalesces across pane lookups with a short TTL: at most one census
// and one lazily-shared metadata+header pass per window, so chat/preview/
// model on several panes never fan out scans. The header pass uses the
// MINIMUM conservative birth across census rows; cmdSelect then applies each
// target's own strict birth. Failures inside a window are cached too — no
// RPC storm — and never fall back to a previous window's selection. Selection
// is display-only: no send routing, no writes, no per-pane file caching.
import type { AgentCensus, AgentProcess } from './agentCensus'
import { cmdLaunchArgs } from './agentCensus'
import { agentCensus } from './agentProcesses'
import type { ShellExec } from './fsx'
import { cmdFiles } from './commandCodeFiles'
import { type CmdHeadersResult, createCmdHeaders } from './commandCodeHeaders'
import { type CmdSelection, type CmdUnavailable, absPath, cmdProjectsRoot, cmdResumeSeed, cmdSelect } from './commandCodeSessions'

// The terminal.get fields this resolver trusts. state is core's terminal
// state — only an exact 'live' resolves. argv is the RECORDED root launch
// argv; foreground is core's reported foreground pid. Nothing else — no cwd,
// created_ms, titles or env — is identity evidence.
export interface CmdTerminalDetail {
  state?: string
  pid?: number
  argv?: string[]
  foreground?: { pid?: number } | null
}
export type CmdLocateUnavailable = 'detail' | CmdUnavailable
export type CmdLocate = { file: string, session: string } | { unavailable: CmdLocateUnavailable }
export interface CmdCore {
  locate(detail: CmdTerminalDetail | null | undefined): Promise<CmdLocate>
}

const BAD_CENSUS: AgentCensus = { complete: false, incomplete: 'unavailable', processes: [], uncertain: [], scanned: 0, unknown: 0 }
const safePid = (p: unknown): p is number => Number.isSafeInteger(p) && (p as number) > 0

export function createCmdCore(exec: ShellExec, home: string, opts: { root?: string, timeoutMs?: number, ttlMs?: number, now?: () => number } = {}): CmdCore {
  const root = opts.root || cmdProjectsRoot(home)
  const timeoutMs = opts.timeoutMs ?? 10000
  // The freshness window stays genuinely short (~1s): it coalesces pane
  // lookups, it is not a cache. An override can never stretch it.
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs! >= 0 ? Math.min(opts.ttlMs!, 1000) : 1000
  const now = opts.now ?? Date.now
  const headers = createCmdHeaders(exec, home, { root, timeoutMs })

  // One evidence slot per window. Census is fetched eagerly per slot; the
  // metadata+header pass starts only when a locate() clears ownership and
  // peer checks, and is shared by every locate() inside the window.
  // Freshness starts when the last in-flight work SETTLES — a still-busy
  // slot is shared by any later locate however much time passed, so a slow
  // census or header pass can never spawn a duplicate. ttlMs: 0 forces a
  // refresh only after pending work settles.
  let slot: { busy: number, settledAt: number, census: Promise<AgentCensus>, headers: Promise<CmdHeadersResult | null> | null } | null = null
  const settle = (s: NonNullable<typeof slot>) => { if (--s.busy === 0) s.settledAt = now() }
  const current = () => {
    if (slot) {
      if (slot.busy > 0) return slot // pending work shares regardless of age
      const age = now() - slot.settledAt
      if (age >= 0 && age < ttlMs) return slot // a backwards clock is never a hit
    }
    const s: NonNullable<typeof slot> = { busy: 1, settledAt: 0, census: null as unknown as Promise<AgentCensus>, headers: null }
    s.census = agentCensus(exec, { timeoutMs }).catch(() => BAD_CENSUS).finally(() => settle(s))
    return (slot = s)
  }
  const headerEvidence = (s: NonNullable<typeof slot>) => s.headers ??= (s.busy++, (async () => {
    try {
      const c = await s.census
      if (!c.complete || c.processes.length === 0) return null
      // One machine snapshot for ALL panes: pre-min-birth files skip the
      // read but still land in the basename catalog; cmdSelect applies each
      // target's own strict birth afterwards.
      const afterMs = Math.min(...c.processes.map(p => p.startedAt!))
      return await headers.headers(await cmdFiles(exec, home, { root, timeoutMs }), { afterMs })
    } catch { return null } finally { settle(s) }
  })())

  const un = (unavailable: CmdLocateUnavailable): CmdLocate => ({ unavailable })
  // The earliest machine wall at which a generation was sampled as a
  // classified cmd row: the ONLY provable upper bound on a non-root agent's
  // start (a shell can exec cmd much later without changing pid/startTicks,
  // and no protocol field records exec). Rows feed it only from a COMPLETE
  // census; entries whose generation is absent from a complete census are
  // pruned — pid+startTicks can never recur, so forgetting only ever raises
  // a bound, never lowers it. An incomplete census prunes nothing. Bounded
  // by the census itself; a fresh instance re-arms conservatively.
  const seen = new Map<string, number>()

  return {
    async locate(detail) {
      // A finished/missing detail can never claim a pid later reused
      // elsewhere; only an explicit live state with a valid root pid
      // resolves — anything else (finished, exited, missing) fails here,
      // before any census or file work.
      if (!detail || detail.state !== 'live' || !safePid(detail.pid)) return un('detail')
      const s = current()
      const census = await s.census
      if (!census.complete) return un('incomplete')

      // Record the first cmd observation of every generation in this
      // census, then prune generations no longer live. Rows without a
      // generation token or a usable machine wall can never be targets.
      const gens = new Set<string>()
      for (const p of census.processes) {
        if (p.startTicks === undefined || p.observedAt === undefined) continue
        const k = `${p.pid}:${p.startTicks}`
        gens.add(k)
        if (!seen.has(k)) seen.set(k, p.observedAt)
      }
      for (const k of seen.keys()) if (!gens.has(k)) seen.delete(k)

      let proc: AgentProcess
      const fg = detail.foreground?.pid
      const fgRow = safePid(fg) ? census.processes.find(p => p.pid === fg) : undefined
      const rootRow = census.processes.find(p => p.pid === detail.pid)
      if (fgRow) proc = fgRow // proven foreground cmd: what the terminal shows
      else if (rootRow) proc = rootRow
      else {
        // A shell/wrapper root: exactly ONE direct cmd child is provable;
        // deeper chains are invisible to a cmd-only census, and several
        // direct children are ambiguous — never first-row guessing.
        const kids = census.processes.filter(p => p.ppid === detail.pid)
        if (kids.length !== 1) return un('target')
        proc = kids[0]!
      }
      // A target that IS the terminal root — found directly or reported as
      // foreground with the root's pid — needs recorded launch argv proving a
      // cmd launch: an old shell that exec'd cmd keeps its older start ticks,
      // which do not bound the agent's birth. Reject the unproven root rather
      // than show old post-shell-birth files.
      let argv: { argv: string[], argvExact: boolean } | undefined
      if (proc.pid === detail.pid) {
        if (!detail.argv?.length || !cmdLaunchArgs(detail.argv)) return un('target')
        argv = { argv: detail.argv, argvExact: true } // recorded == launch-exact
      } else argv = proc.argv?.length ? { argv: proc.argv, argvExact: proc.argvExact === true } : undefined
      if (proc.startTicks === undefined || !proc.cwd) return un('target')
      // A non-root target can be an old shell that exec'd cmd: startTicks
      // bounds the shell's fork, not the agent's start. The strict bound is
      // the first machine wall we observed this generation classified as
      // cmd — carried by the census record, never the coordinator clock.
      // Missing observation: unavailable, no fallback. An observedAt just
      // BELOW startedAt is valid too (the birth upper bound adds one clock
      // tick): both are proven upper bounds — take the stricter one.
      let bornMs = proc.startedAt
      if (proc.pid !== detail.pid) {
        const obs = seen.get(`${proc.pid}:${proc.startTicks}`)
        if (obs === undefined || bornMs === undefined) return un('target')
        bornMs = Math.max(bornMs, obs)
      }
      // Two live same-cwd cmd peers — nested, external, anywhere — make the
      // unique-conversation premise unproven: refuse before any file IO.
      if (census.processes.filter(p => p.cwd === proc.cwd).length !== 1) return un('peers')
      // Same for an unclassifiable process in the target's cwd or with an
      // unreadable one: a possible hidden peer refuses before file IO. The
      // selector re-checks against eligible candidate header cwds.
      if (census.uncertain.some(u => !u.cwd || !absPath(u.cwd) || u.cwd === proc.cwd)) return un('peers')

      const hdr = await headerEvidence(s)
      if (!hdr?.complete) return un('incomplete')
      // A full-UUID seed is admitted only when globally unique across the
      // whole basename catalog, pre-birth entries included — a pre-birth
      // duplicate in another project dir must not make it look unique.
      if (argv?.argvExact === true) {
        const seed = cmdResumeSeed(root, argv.argv)
        if (seed?.kind === 'id' && hdr.files.filter(f => f.id === seed.value).length !== 1) argv = undefined
      }
      const sel: CmdSelection = cmdSelect({
        root, census,
        target: { pid: proc.pid, startTicks: proc.startTicks, ...(bornMs === undefined ? {} : { bornMs }) },
        ...(argv ? { argv } : {}),
        candidates: { complete: hdr.complete, items: hdr.items }
      })
      return sel
    }
  }
}
