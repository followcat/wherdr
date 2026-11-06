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
// Evidence coalesces across pane lookups with a short TTL and TWO census
// phases per window: a cheap ownership census gates the lazily-shared
// metadata+header collection, and the final selection is made ONLY on a
// real post-collection census begun after that collection resolves — a
// process that starts and writes while the listing is in flight and is
// still live at the second sample is judged there, never hidden by the
// pre-collection rows. The
// header pass uses the MINIMUM conservative birth across census rows;
// cmdSelect then applies each target's own strict birth. Failures inside a
// window are cached too — no RPC storm — and never fall back to a previous
// window's selection. Selection is display-only: no send routing, no
// writes, no per-pane file caching.
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

  // One evidence slot per window: the ownership census (c1) is fetched
  // eagerly; the collection — one metadata+header pass followed by a REAL
  // post-collection census (c2) — starts only when a locate() clears the
  // cheap ownership and peer checks, and is shared by every locate() inside
  // the window. Freshness starts when the last in-flight work SETTLES — a
  // still-busy slot is shared by any later locate however much time passed,
  // so a slow census or header pass can never spawn a duplicate or relabel
  // an older sample as fresh. ttlMs: 0 forces a refresh only after pending
  // work settles.
  let slot: { busy: number, settledAt: number, census: Promise<AgentCensus>, col: Promise<{ hdr: CmdHeadersResult, c2: AgentCensus } | null> | null } | null = null
  const settle = (s: NonNullable<typeof slot>) => { if (--s.busy === 0) s.settledAt = now() }
  const current = () => {
    if (slot) {
      if (slot.busy > 0) return slot // pending work shares regardless of age
      const age = now() - slot.settledAt
      if (age >= 0 && age < ttlMs) return slot // a backwards clock is never a hit
    }
    const s: NonNullable<typeof slot> = { busy: 1, settledAt: 0, census: null as unknown as Promise<AgentCensus>, col: null }
    // Each sample is remembered exactly once, at ITS resolution — never
    // replayed per lookup. Replaying an older c1 after c2 resolved could
    // prune a generation c2 just witnessed and re-arm its wait later.
    s.census = agentCensus(exec, { timeoutMs }).catch(() => BAD_CENSUS)
      .then(c => { observe(c); return c }).finally(() => settle(s))
    return (slot = s)
  }
  const collect = (s: NonNullable<typeof slot>) => s.col ??= (s.busy++, (async () => {
    try {
      const c = await s.census
      if (!c.complete || c.processes.length === 0) return null
      // One machine snapshot for ALL panes: pre-min-birth files skip the
      // read but still land in the basename catalog; cmdSelect applies each
      // target's own strict birth afterwards.
      const afterMs = Math.min(...c.processes.map(p => p.startedAt!))
      const hdr = await headers.headers(await cmdFiles(exec, home, { root, timeoutMs }), { afterMs })
      if (!hdr?.complete) return null
      // The final sample is a real second census begun only AFTER the
      // header pass resolved: a process that started and flushed during
      // collection and is still live at this sample is visible to the
      // selection. (One that already exited leaves only its files — the
      // approved residual.)
      const c2 = await agentCensus(exec, { timeoutMs }).catch(() => BAD_CENSUS)
      observe(c2)
      return { hdr, c2 }
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
  // Record the first cmd observation of every generation in a COMPLETE
  // census, then prune generations no longer live — an incomplete census
  // records and prunes nothing. Rows without a generation token or a usable
  // machine wall can never be targets. Runs once per actual sample, in
  // chronological sample order; a later phase's wall never overwrites.
  const observe = (c: AgentCensus) => {
    if (!c.complete) return
    const gens = new Set<string>()
    for (const p of c.processes) {
      if (p.startTicks === undefined || p.observedAt === undefined) continue
      const k = `${p.pid}:${p.startTicks}`
      gens.add(k)
      if (!seen.has(k)) seen.set(k, p.observedAt)
    }
    for (const k of seen.keys()) if (!gens.has(k)) seen.delete(k)
  }

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

      const pack = await collect(s)
      if (!pack?.hdr.complete) return un('incomplete')
      const c2 = pack.c2
      if (!c2.complete) return un('incomplete') // never the c1-based answer
      // Everything below is judged on the post-collection census: the
      // target's generation must still be the same row (a lost pid, a
      // reused generation or a moved cwd can never keep the earlier
      // sample's answer), and every peer/unknown/ownership check runs on
      // the fresh sample too.
      const row = c2.processes.find(p => p.pid === proc.pid && p.startTicks === proc.startTicks)
      if (!row || row.cwd !== proc.cwd) return un('target')
      proc = row
      if (proc.pid !== detail.pid) argv = proc.argv?.length ? { argv: proc.argv, argvExact: proc.argvExact === true } : undefined
      bornMs = proc.startedAt
      if (proc.pid !== detail.pid) {
        const obs = seen.get(`${proc.pid}:${proc.startTicks}`)
        if (obs === undefined || bornMs === undefined) return un('target')
        bornMs = Math.max(bornMs, obs)
      }
      // The generation token validated identical across both phases — a
      // missing token falls to the selector's own metadata refusal.
      const startTicks = proc.startTicks
      const hdr = pack.hdr
      // A full-UUID seed is admitted only when globally unique across the
      // whole basename catalog, pre-birth entries included — a pre-birth
      // duplicate in another project dir must not make it look unique.
      if (argv?.argvExact === true) {
        const seed = cmdResumeSeed(root, argv.argv)
        if (seed?.kind === 'id' && hdr.files.filter(f => f.id === seed.value).length !== 1) argv = undefined
      }
      const sel: CmdSelection = cmdSelect({
        root, census: c2,
        target: { pid: proc.pid, startTicks: startTicks ?? -1, ...(bornMs === undefined ? {} : { bornMs }) },
        ...(argv ? { argv } : {}),
        candidates: { complete: hdr.complete, items: hdr.items }
      })
      return sel
    }
  }
}
