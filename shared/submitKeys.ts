// Alternate submission keys: which keys, beyond the implicit Enter, are
// verified to end a draft submission for an agent in a given context.
// In terminal mode the user presses these on the keybar; in conversation
// mode the same key means "send this draft with <key>" (text, then the
// key — the agent treats it natively, as if typed into its own field).
//
// Only VERIFIED bindings ship here: a key is listed once its real behavior
// on the agent has been observed. An agent with no entry keeps Enter as
// its only terminator; every other keybar key stays a literal key.
//
// `working`: the agent is mid-turn — some terminators only exist then
// (Codex's Tab queues the draft for the turn's end; idle, Tab is a local
// field gesture and must not swallow a draft).
const TABLE: Record<string, (ctx: { working: boolean }) => string[]> = {
  // Codex: Tab on a typed draft queues it while the agent works — verified
  // on 0.166.0: "Queued follow-up inputs", delivered at the turn's end.
  // Idle, Tab is a local field gesture and must not swallow a draft.
  codex: ({ working }) => (working ? ['tab'] : []),
  // Claude: Ctrl+Enter submits a draft idle and queues it while working —
  // verified on 2.1.247 ("Press up to edit queued messages"). It is not the
  // drain/flush key it was suspected to be.
  claude: () => ['ctrl+enter'],
  // Devin: no alternate terminator. Ctrl+Enter is what its TUI would queue a
  // draft on, but over send_input the chord is not a queue action: on an idle
  // pane it submits the draft like Enter; mid-turn it leaves the draft in the
  // field (both measured on v3000.11.234). Offered as "Send with Ctrl+Enter",
  // the send left the typed text stranded in the input box, where the next
  // message's text accumulated until a real Enter flushed the pile as one
  // merged/queued delivery. Plain Send stays Enter: on a working Devin it
  // steers the running turn.
  devin: () => [],
}

// Keys that may terminate a draft for `agent` right now. Enter is never
// listed: it is the default submission everywhere, not an alternate.
export function submitKeysFor(agent: string | null | undefined, ctx: { working?: boolean } = {}): string[] {
  return (agent && TABLE[agent]?.({ working: Boolean(ctx.working) })) || []
}

export const isSubmitKey = (agent: string | null | undefined, key: string, ctx: { working?: boolean } = {}) => submitKeysFor(agent, ctx).includes(key)

// The key is a terminator for `agent` under some context. What a submission
// asks for is stored so a held message can still get its key at delivery —
// where the context is checked again (isSubmitKey).
export const possibleSubmitKey = (agent: string | null | undefined, key: string) => submitKeysFor(agent, { working: true }).includes(key) || submitKeysFor(agent, { working: false }).includes(key)
