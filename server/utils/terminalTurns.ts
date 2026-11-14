// One writer at a time per terminal. wherdr types into an agent from several
// places: the conversation's composer (coreSend), and the engine (wakes,
// reports, nudges, see coreAdminDeps). Two of them at once mix their texts in
// the agent's input, and the user's message fails while a wake is being typed.
// Each waits for the one before it on the same terminal, whatever its outcome,
// and a moment more: Claude still takes the text it just got (it turns photo
// paths into images afterwards). A paste in that moment can be submitted and
// also left typed in its input, a ghost "Not sent" copy.

type Call = <T>(method: string, params: object, timeout: number) => Promise<T>

const tails = new Map<string, Promise<unknown>>()
export const SETTLE_MS = 1500

/** Someone is typing into this terminal now (or waits to). */
export const typingInto = (terminal: string) => tails.has(terminal)

/** Runs `fn` once the earlier writers of `terminal` are done. */
export function inTurn<T>(terminal: string, fn: () => Promise<T>, settleMs = SETTLE_MS): Promise<T> {
  const run = (tails.get(terminal) ?? Promise.resolve()).catch(() => {}).then(fn)
  const tail = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, settleMs)))
  tails.set(terminal, tail)
  void tail.then(() => { if (tails.get(terminal) === tail) tails.delete(terminal) })
  return run
}

/** A core call whose terminal.send waits its turn. */
export const takingTurns = (call: Call, settleMs = SETTLE_MS): Call => (method, params, timeout) => {
  const terminal = (params as { terminal?: unknown }).terminal
  return method === 'terminal.send' && typeof terminal === 'string'
    ? inTurn(terminal, () => call(method, params, timeout), settleMs)
    : call(method, params, timeout)
}
