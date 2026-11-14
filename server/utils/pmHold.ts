// The engine's in-memory guards (a task's running action, an agent starting, a
// periodic pass): each hold has a time limit. A hold past it is logged and
// released, so a promise that never settles cannot block its key forever. The
// release a holder gets frees only its own hold: a late finally never frees
// the next holder's.
export type Release = (() => void) & { lost: () => boolean }

export class Holds {
  private held = new Map<string, { at: number, what: string }>()
  constructor(private name: string, private limitMs: number, private log: (line: string) => void = l => console.warn(l)) {}

  // Held now, within its limit; a hold past it is released here, with a log line.
  has(key: string, now = Date.now()) {
    const h = this.held.get(key)
    if (!h) return false
    if (now - h.at < this.limitMs) return true
    this.held.delete(key)
    this.log(`[pm] ${this.name} ${key}: held ${Math.round((now - h.at) / 1000)} s by ${h.what}, past its ${Math.round(this.limitMs / 1000)} s limit: released`)
    return false
  }

  // The hold's release, or undefined when the key is held already. lost():
  // the hold went past its limit (released, maybe taken by another holder).
  take(key: string, what: string, now = Date.now()): Release | undefined {
    if (this.has(key, now)) return
    const mine = { at: now, what }
    this.held.set(key, mine)
    const release = () => { if (this.held.get(key) === mine) this.held.delete(key) }
    return Object.assign(release, { lost: () => this.held.get(key) !== mine || Date.now() - mine.at >= this.limitMs })
  }
}
