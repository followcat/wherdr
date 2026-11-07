// Machine-scoped OpenCode conversation locator: it turns a LIVE core
// terminal detail (root pid + recorded argv + foreground process) into the
// session the terminal most probably shows, by composing the bounded
// process scan (opencodeProcs), the service discovery inside the catalog
// read (opencodeReadCatalog) and the reduced session rows it returns.
//
// Ownership is fail-closed. Target = a proven foreground opencode PID, else
// the root PID when its recorded launch argv proves an opencode launch.
// Process cwd/birth come from the scan row alone — never pane.cwd — and two
// same-cwd opencode peers (or an unclassifiable one in scope) refuse before
// any service IO. For a non-root target the shell could have exec'd
// opencode late: startTicks then bounds the fork, not the agent's start,
// so the strict bound is the first machine wall this generation was
// observed classified as opencode — carried by this locator's `seen`, never
// the coordinator clock. A session qualifies only when its catalog row's
// directory equals the process cwd AND its `updated` stamp is at or after
// that bound; the most recently updated qualifying row answers, a tie is
// ambiguous, no candidate or a failed discovery/catalog/scan is
// unavailable — the pane stays on the terminal view.
//
// Evidence: a cheap first scan gates the catalog read; the final selection
// is judged on a REAL second scan begun after the catalog resolves — a
// process that starts while the catalog is in flight and is still live at
// the second sample is refused as a peer or judged there, never hidden by
// the earlier rows. Failures are never fallbacks to an older window.
import type { ShellExec } from './fsx'
import { opencodeProcs, type OpencodeScan } from './opencodeProcs'
import { opencodeReadCatalog, type OpencodeReadCatalog } from './opencodeReadCatalog'

// The terminal.get fields this resolver trusts. state is core's terminal
// state — only an exact 'live' resolves. argv is the RECORDED root launch
// argv; foreground is core's reported foreground process. Nothing else —
// no pane titles, env or session hints — is identity evidence.
export interface OcTerminalDetail {
  state?: string
  pid?: number
  argv?: string[]
  created_ms?: number
  foreground?: { pid?: number, name?: string, argv?: string[], cwd?: string } | null
}
export type OcUnavailable = 'detail' | 'target' | 'scan' | 'peers' | 'catalog' | 'session' | 'ambiguous'
export type OcLocate = { session: string, server: string } | { unavailable: OcUnavailable }
export interface OcCore {
  locate(detail: OcTerminalDetail | null | undefined): Promise<OcLocate>
}

const BAD_SCAN: OpencodeScan = { complete: false, rows: [], uncertain: [], scanned: 0, emitted: 0 }
const safePid = (p: unknown): p is number => Number.isSafeInteger(p) && (p as number) > 0
const base = (s: string | undefined) => (s || '').split('/').pop() || ''

// The same shape the producer emits: the process name or an opencode
// element inside the first argv positions (npx opencode, node /x/opencode,
// env X=1 opencode, a rewritten argv0).
const ocShape = (name: string | undefined, argv: string[] | undefined) =>
  base(name) === 'opencode' || (argv || []).slice(0, 8).some(a => base(a) === 'opencode')

export function createOpencodeCore(exec: ShellExec, home: string, opts: {
  timeoutMs?: number
  ttlMs?: number
  now?: () => number
  scan?: (timeoutMs: number) => Promise<OpencodeScan>
  catalog?: (directory: string) => Promise<OpencodeReadCatalog>
} = {}): OcCore {
  const timeoutMs = opts.timeoutMs ?? 10000
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs! >= 0 ? Math.min(opts.ttlMs!, 1000) : 800
  const now = opts.now ?? Date.now
  const scan = opts.scan ?? ((ms: number) => opencodeProcs(exec, { timeoutMs: ms }).catch(() => BAD_SCAN))
  const catalog = opts.catalog ?? ((directory: string) => opencodeReadCatalog(exec, home, { directory }).catch(() => ({ ok: false as const, error: 'unavailable' })))

  // The earliest machine wall at which a generation was sampled as an
  // opencode row: the ONLY provable upper bound on a non-root agent's
  // exec (a shell can exec opencode much later without changing
  // pid/startTicks, and no protocol field records exec). Rows feed it only
  // from a COMPLETE scan; entries whose generation is absent from a
  // complete scan are pruned — pid+startTicks can never recur, so
  // forgetting only ever raises a bound, never lowers it. An incomplete
  // scan prunes nothing. A fresh instance re-arms conservatively.
  const seen = new Map<string, number>()
  const observe = (s: OpencodeScan, wall: number) => {
    if (!s.complete) return
    const gens = new Set<string>()
    for (const p of [...s.rows, ...s.uncertain]) {
      if (p.startTicks === undefined) continue
      const k = `${p.pid}:${p.startTicks}`
      gens.add(k)
      if (!seen.has(k)) seen.set(k, wall)
    }
    for (const k of seen.keys()) if (!gens.has(k)) seen.delete(k)
  }

  // One shared first scan per window: it coalesces pane lookups, it is not
  // a cache of the answer. A still-in-flight scan is shared however much
  // time passed, so a slow scan can never spawn a duplicate or relabel an
  // older sample as fresh; freshness starts when it SETTLES.
  let slot: { at: number, busy: boolean, scan: Promise<{ s: OpencodeScan, wall: number }> } | null = null
  const first = () => {
    if (slot && (slot.busy || (now() - slot.at >= 0 && now() - slot.at < ttlMs))) return slot.scan
    const work = scan(timeoutMs).then(s => ({ s, wall: now() }))
    const rec = { at: 0, busy: true, scan: work }
    void work.then(() => { rec.busy = false; rec.at = now() }, () => { rec.busy = false; rec.at = now() })
    return (slot = rec).scan
  }

  const un = (unavailable: OcUnavailable): OcLocate => ({ unavailable })
  // The peer rule on one scan: the target's own row in its cwd, and any
  // unclassifiable row whose cwd is unreadable or the same.
  const peers = (s: OpencodeScan, cwd: string, pid: number) =>
    s.rows.some(r => r.pid !== pid && r.cwd === cwd)
    || s.uncertain.some(u => u.cwd === cwd || !u.cwd)

  return {
    async locate(detail) {
      if (!detail || detail.state !== 'live' || !safePid(detail.pid)) return un('detail')
      const fg = detail.foreground
      let pid: number
      if (fg && safePid(fg.pid) && ocShape(fg.name, fg.argv)) pid = fg.pid
      else if (ocShape(undefined, detail.argv)) pid = detail.pid
      else return un('target')
      // The recorded launch argv is birth evidence only when it proves the
      // terminal's own root was launched AS opencode: core reported the
      // root as foreground or as the pane shell — either way detail.argv
      // recorded THIS pid's launch. A root exec'd into opencode after a
      // shell launch, or a child pid (opencode run inside a shell), has an
      // exec gap the launch record says nothing about — the scan
      // observation bound applies instead.
      const root = pid === detail.pid && ocShape(undefined, detail.argv)

      const { s: s1, wall } = await first()
      observe(s1, wall)
      if (!s1.complete) return un('scan')
      const row = s1.rows.find(r => r.pid === pid)
      // The target must be a classified row of this sample: core says
      // opencode but the scan cannot see it (shape missed, unreadable cwd)
      // — inconsistent evidence, not a fallback case.
      if (!row || !row.cwd.startsWith('/')) return un('target')
      const cwd = row.cwd
      // Birth bound: the fork bound raised to the first observation for a
      // non-root target (the exec gap); a root launch is bounded by the
      // terminal's own spawn record too.
      let born = row.startedAt ?? (root ? detail.created_ms : undefined)
      if (born === undefined) return un('target')
      if (root && typeof detail.created_ms === 'number') born = Math.max(born, detail.created_ms)
      if (!root) {
        const obs = row.startTicks !== undefined ? seen.get(`${pid}:${row.startTicks}`) : undefined
        if (obs === undefined) return un('target')
        born = Math.max(born, obs)
      }
      if (peers(s1, cwd, pid)) return un('peers')

      const cat = await catalog(cwd)
      if (!cat.ok) return un('catalog')

      // The second sample is a real scan begun only after the catalog
      // resolved: the target's generation must still be the same row (a
      // lost pid, a reused generation or a moved cwd can never keep the
      // earlier sample's answer), and every peer check runs fresh.
      const s2 = await scan(timeoutMs).catch(() => BAD_SCAN)
      observe(s2, now())
      if (!s2.complete) return un('scan')
      const again = s2.rows.find(r => r.pid === pid && r.startTicks === row.startTicks)
      if (!again || again.cwd !== cwd) return un('target')
      if (peers(s2, cwd, pid)) return un('peers')

      const cands = cat.rows.filter(r => r.directory === cwd && r.updated >= born)
      if (!cands.length) return un('session')
      let best = cands[0]!
      let tie = false
      for (const r of cands.slice(1)) {
        if (r.updated > best.updated) { best = r; tie = false }
        else if (r.updated === best.updated) tie = true
      }
      if (tie) return un('ambiguous')
      return { session: best.id, server: cat.server }
    },
  }
}
