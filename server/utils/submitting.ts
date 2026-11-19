// Messages to Claude still being submitted (coreInput.ts): noted in
// DATA_DIR/submitting.json from before the send until Claude took them or
// wherdr gave up, so a restart of wherdr mid-send (the host updates itself)
// resumes them (WHR-419). Read by the server's user only, kept 2 minutes.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from './env'

export interface Submitting { id: string, terminal: string, text: string, at: number }
export const SUBMITTING_TTL_MS = 120_000
const FILE = path.join(DATA_DIR, 'submitting.json')

function load(): Submitting[] {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(list) ? list.filter(s => s && typeof s.terminal === 'string' && typeof s.text === 'string' && typeof s.at === 'number') : []
  } catch { return [] }
}

function save(list: Submitting[]) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = `${FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 })
    fs.renameSync(tmp, FILE)
  } catch { /* a note lost only means no resume after a restart */ }
}

const fresh = (s: Submitting, now: number) => now - s.at < SUBMITTING_TTL_MS

// Terminals with a send running in this process, for the conversation's
// "Sending…" (pane.sending): the send runs here whatever the page does. The
// texts are kept too: Claude's field may show only "[Pasted text #N +K lines]",
// and the conversation shows the user's own text instead (pane.inputText),
// also once the send is over (refused, the message left there): the last one
// sent to each terminal stays known (coreScreen.ts shows it only while the
// field holds it).
const running = new Map<string, string[]>()
const lastSent = new Map<string, string>()
export const sendingTo = (terminal: string | undefined) => Boolean(terminal && running.get(terminal)?.length)
export const sendingText = (terminal: string | undefined) => (terminal && running.get(terminal)?.at(-1)) || undefined
export const lastSentText = (terminal: string | undefined) => (terminal && (sendingText(terminal) ?? lastSent.get(terminal))) || undefined
// Called on each start and end of a send: the open conversations get the new
// state at once (state.ts polls), not at the next core event.
let changed = () => {}
export const onSubmittingChange = (f: () => void) => { changed = f }

/** Notes a message being submitted; returns what forgets it. */
export function noteSubmitting(terminal: string, text: string): () => void {
  const s = { id: randomUUID(), terminal, text, at: Date.now() }
  running.set(terminal, [...running.get(terminal) || [], text])
  lastSent.set(terminal, text)
  save([...load().filter(x => fresh(x, s.at)), s])
  changed()
  let done = false
  return () => {
    if (done) return
    done = true
    const list = running.get(terminal) || []
    list.splice(list.indexOf(text), 1)
    if (!list.length) running.delete(terminal)
    save(load().filter(x => x.id !== s.id && fresh(x, Date.now())))
    changed()
  }
}

/** At startup: the sends a restart interrupted, still fresh. */
export function takeSubmitting(): Submitting[] {
  const now = Date.now()
  const list = load()
  if (list.length) save([])
  return list.filter(s => fresh(s, now))
}
