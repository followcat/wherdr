// Bias terms for context-capable ASR engines (asrModel.ts `context`). The
// words worth hinting are already in strings the app holds — pane identity
// (agent, machine, name), cwd segments, and technical tokens in the draft
// and attachment names. Harvested at mic-press time, deduped, weighted,
// capped at 30. The harvest is ASCII-technical-token shaped (camelCase,
// snake_case, dotted, paths); identity fields pass whole so non-ASCII pane
// names still get in — CJK prose just can't be word-split without a
// segmenter, which this deliberately doesn't pull in.
const TECH = /[A-Za-z][A-Za-z0-9_+.#/-]{2,}/g
// Common English function words, kept out of the term list. The harvest
// only sees ASCII anyway, so ASCII prose is its only noise source — and
// programming vocabulary is spoken in English regardless of the speaker's
// language. Deliberately small: real terms outrank leftovers anyway, this
// just needs the most common fillers, not a dictionary.
const STOP = new Set('the a an and or of to in on at for with from by as is are was were be been it its this that these those you your we our they their he she his her i me my do does did have has had will would can could should may might must not no yes if then else than when where what which who how all any some more most other each every both same such own just only very too also now new get got make made take use used see say go come know think want need like keep let put set run add try work look ask help find check fix open close show list give send move delete create update save load start stop done next last back out off up down over under again still even ever here there about into through between after before during while since but thing things way time'.split(' '))

export interface AsrContextInput {
  agent?: string | null
  machine?: string | null
  name?: string | null
  title?: string | null
  cwd?: string | null
  draft?: string
  files?: (string | null | undefined)[]
  recent?: string[]
}

// A bare comma-joined term list — the hotword format ASR context prompts
// take — so nothing in the output leans on one language's scaffolding.
export function buildAsrContext(o: AsrContextInput): string {
  const byKey = new Map<string, { t: string, w: number }>()
  const add = (term: unknown, w: number) => {
    const t = String(term || '').trim().replace(/^[-./_+]+|[-./_+]+$/g, '')
    if (t.length < 2 || t.length > 60) return
    const key = t.toLowerCase()
    if (STOP.has(key) || /^https?$/.test(key)) return
    const e = byKey.get(key)
    if (e) { e.w = Math.max(e.w, w); return }
    byKey.set(key, { t, w })
  }
  const harvest = (text: string | null | undefined, w: number) => {
    if (!text) return
    for (const m of String(text).matchAll(TECH)) add(m[0], w)
  }
  // Identity terms first: what this pane is decides what you'll say about it.
  for (const v of [o.agent, o.machine, o.name]) add(v, 4)
  // cwd tail segments ("~/AIcontrol/phone/wherdr" → phone, wherdr).
  for (const seg of (o.cwd || '').split('/').filter(Boolean).slice(-2)) add(seg, 2)
  if (o.title) harvest(o.title, 2)
  if (o.draft) harvest(o.draft, 3)
  for (const f of o.files || []) harvest(f, 2)
  for (const r of o.recent || []) harvest(r, 1)
  return [...byKey.values()].sort((a, b) => b.w - a.w).map(e => e.t).slice(0, 30).join(', ')
}
