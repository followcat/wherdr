// When something runs on its own: `every 2h`, `daily 09:00`, `mon 09:00`,
// `mon,thu 09:00`, or a five-field cron (`17 4 * * *`), in this machine's
// time zone. A missed slot (wherdr was down) runs once, never once per slot:
// the caller keeps the time of its last run and asks `due`.

export type Schedule =
  | { every: number } // ms
  | { min: number[], hour: number[], dom: number[] | null, mon: number[] | null, dow: number[] | null }

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

// One cron field: *, n, a-b, lists, /step. null when it is * (no restriction).
function field(s: string, lo: number, hi: number, names: string[] = []): number[] | null | undefined {
  if (s === '*') return null
  const out = new Set<number>()
  for (const part of s.split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(part)
    if (!m) return undefined
    const num = (x: string) => (names.includes(x) ? names.indexOf(x) : /^\d+$/.test(x) ? Number(x) : Number.NaN)
    const [a, b] = m[1] === '*' ? [lo, hi] : m[1]!.split('-').map(num) as [number, number?]
    const end = b ?? (m[2] ? hi : a)
    const step = m[2] ? Number(m[2]) : 1
    if (!(a >= lo && end <= hi && a <= end && step > 0)) return undefined
    for (let v = a; v <= end; v += step) out.add(names === DAYS && v === 7 ? 0 : v)
  }
  return [...out].sort((x, y) => x - y)
}

// The text the user wrote → a schedule, or the reason it is not one.
export function parseSchedule(raw: unknown): Schedule | { error: string } {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\s+/g, ' ') : ''
  const bad = { error: 'a schedule: every 2h, daily 09:00, mon 09:00, mon,thu 09:00 or a cron (m h dom mon dow)' }
  const every = /^every (\d{1,4})([mh])$/.exec(s)
  if (every) return Number(every[1]) > 0 ? { every: Number(every[1]) * (every[2] === 'h' ? 3_600_000 : 60_000) } : bad
  const at = /^(daily|[a-z]{3}(?:,[a-z]{3})*) ([01]?\d|2[0-3]):([0-5]\d)$/.exec(s)
  if (at) {
    const dow = at[1] === 'daily' ? null : at[1]!.split(',').map(d => DAYS.indexOf(d))
    if (dow?.some(d => d < 0)) return bad
    return { min: [Number(at[3])], hour: [Number(at[2])], dom: null, mon: null, dow: dow && [...new Set(dow)].sort() }
  }
  const f = s.split(' ')
  if (f.length !== 5) return bad
  const [min, hour, dom, mon, dow] = [field(f[0]!, 0, 59), field(f[1]!, 0, 23), field(f[2]!, 1, 31), field(f[3]!, 1, 12), field(f[4]!, 0, 7, DAYS)]
  if ([min, hour, dom, mon, dow].includes(undefined)) return bad
  return { min: min ?? range(0, 59), hour: hour ?? range(0, 23), dom: dom!, mon: mon!, dow: dow! }
}

// The first slot strictly after `after` (ms), local time; null if none within 5 years.
export function nextRun(s: Schedule, after: number): number | null {
  if ('every' in s) return after + s.every
  const d = new Date(after)
  d.setSeconds(0, 0)
  for (let day = 0; day < 366 * 5; day++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + day)
    if (s.mon && !s.mon.includes(c.getMonth() + 1)) continue
    // Cron: with both restricted, either day field matches.
    const domOk = !s.dom || s.dom.includes(c.getDate()), dowOk = !s.dow || s.dow.includes(c.getDay())
    if (s.dom && s.dow ? !(domOk || dowOk) : !(domOk && dowOk)) continue
    for (const h of s.hour) for (const m of s.min) {
      const t = new Date(c.getFullYear(), c.getMonth(), c.getDate(), h, m).getTime()
      if (t > after) return t
    }
  }
  return null
}

// Has a slot come since the last run (or the switch-on)? One answer for any
// number of missed slots: the caller then sets `last` to now.
export function due(s: Schedule, last: number, now: number) {
  const n = nextRun(s, last)
  return n !== null && n <= now
}
