// An omp tool call written the way omp's terminal writes it: wall time
// ("0.71s", "3m24s"), the counts after the target ("95 matches · in server",
// "+3/-2") and the note above a cut output ("… 12 earlier lines"). A group of
// calls is drawn as a console (ChatView, OmpTool.vue).
import type { ChatItem, OmpToolView } from '../../shared/types'
import { tl } from './i18n'

// "0.03s" under a minute (omp's "Wall: 0.71s"), then "3m24s", "1h3m".
export function ompWall(ms: number): string {
  if (!(ms >= 0)) return ''
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h${m}m` : `${m}m${s % 60}s`
}

const plural = (n: number, en: string, ens: string, fr: string, frs: string) => `${n} ${n === 1 ? tl(en, fr) : tl(ens, frs)}`

// What omp prints after the target, as separate pieces (the exit code is
// shown on its own, in red).
export function ompToolMeta(v: OmpToolView): string[] {
  const out: string[] = []
  if (typeof v.matches === 'number') {
    out.push(plural(v.matches, 'match', 'matches', 'résultat', 'résultats') + (v.files && v.files > 1 && v.files < v.matches ? ` ${tl(`in ${v.files} files`, `dans ${v.files} fichiers`)}` : ''))
  } else if (typeof v.files === 'number') out.push(plural(v.files, 'file', 'files', 'fichier', 'fichiers'))
  if (v.scope) out.push(`${tl('in', 'dans')} ${v.scope}`)
  if (typeof v.added === 'number' || typeof v.removed === 'number') out.push(`+${v.added || 0}/-${v.removed || 0}`)
  if (v.job) out.push(`${tl('Backgrounded', 'En arrière-plan')}: ${v.job}`)
  if (v.cancelled) out.push(tl('cancelled', 'annulée'))
  return out
}

// Lines of the output not shown above the excerpt (bash keeps the last ones).
export function ompEarlier(v: OmpToolView): number {
  if (!v.out || !v.outLines) return 0
  return Math.max(0, v.outLines - v.out.split('\n').length)
}

// Size of a whole output ("15 lines"), for the user's own "!" / "$" run:
// with no intent nor counts, it tells there is something to unfold.
export function ompOutSize(v: OmpToolView): string {
  if (!v.out) return ''
  const n = Math.max(v.outLines || 0, v.out.split('\n').length)
  return plural(n, 'line', 'lines', 'ligne', 'lignes')
}

// The call as a console line: bash is its command (and the user's "$" Python
// its code), the others their name and target ("read TASKS.md:5-20",
// "web_search oh-my-pi logo").
export function ompCommandLine(v: OmpToolView): string {
  if (v.title === 'Bash' || v.title === 'Python') return v.target || v.title.toLowerCase()
  const name = v.title.toLowerCase().replace(/\s+/g, '_')
  return v.target ? `${name} ${v.target}` : name
}

// Header of an unfolded output: what it is, and the cut lines above it
// ("… 3 earlier lines"), kept short to hold on one phone line.
export function ompOutHead(v: OmpToolView, error: boolean): { label: string, earlier: string } {
  const n = ompEarlier(v)
  return {
    label: v.diff ? 'Diff' : error ? tl('Error', 'Erreur') : 'Output',
    earlier: n ? `… ${plural(n, 'earlier line', 'earlier lines', 'ligne avant', 'lignes avant')}` : '',
  }
}

// Total wall time of a group of calls (ms), for the console's header.
export const ompTotalMs = (list: readonly ChatItem[]) =>
  list.reduce((s, t) => s + (t.omp && typeof t.omp.ms === 'number' ? t.omp.ms : 0), 0)

// A group drawn as an omp console: only omp calls.
export const isOmpGroup = (list: readonly ChatItem[]) => list.length > 0 && list.every(t => t.omp)

// Calls shown in a console: past OMP_CONSOLE_SHOWN, the last ones only until
// unfolded ("⋯ N earlier actions" above them).
export const OMP_CONSOLE_SHOWN = 3
export function ompConsoleRows<T>(list: readonly T[], open: boolean): { hidden: number, rows: readonly T[] } {
  if (open || list.length <= OMP_CONSOLE_SHOWN) return { hidden: 0, rows: list }
  return { hidden: list.length - OMP_CONSOLE_SHOWN, rows: list.slice(-OMP_CONSOLE_SHOWN) }
}

// A Claude Code or Codex "!" command (its transcript entry, or what the
// screen shows while it runs) drawn as omp's own bash call (ChatShellRun.vue):
// its output (stderr after stdout), its run time when known.
export function shellView(it: Pick<ChatItem, 'text' | 'out' | 'err' | 'ms'>, hidden = 0): OmpToolView {
  const out = [it.out, it.err].filter(Boolean).join('\n')
  return {
    title: 'Bash', target: it.text,
    ...(out ? { out, ...(hidden ? { outLines: hidden + out.split('\n').length } : {}) } : {}),
    ...(typeof it.ms === 'number' ? { ms: it.ms } : {}),
  }
}
