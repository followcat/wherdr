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
  // Devin: Ctrl+Enter submits a draft idle and queues it while working —
  // verified on v3000.11.234 ("1 queued · ↵ send now"), delivered at the
  // turn's end.
  devin: () => ['ctrl+enter'],
}

// Keys that may terminate a draft for `agent` right now. Enter is never
// listed: it is the default submission everywhere, not an alternate.
export function submitKeysFor(agent: string | null | undefined, ctx: { working?: boolean } = {}): string[] {
  return (agent && TABLE[agent]?.({ working: Boolean(ctx.working) })) || []
}

export const isSubmitKey = (agent: string | null | undefined, key: string, ctx: { working?: boolean } = {}) => submitKeysFor(agent, ctx).includes(key)

// The terminator the plain Send delivers when nothing else is asked for —
// undefined keeps the pane's usual Enter. Devin working is the exception:
// its field hands an Enter-message to the running turn as a steer, while
// Ctrl+Enter is the queue (verified: v3000.11 steering release notes). An
// idle Devin submits on Enter like everywhere else.
export function defaultSubmitKey(agent: string | null | undefined, ctx: { working?: boolean } = {}): string | undefined {
  return agent === 'devin' && ctx.working ? 'ctrl+enter' : undefined
}

// The key is a terminator for `agent` under some context. What a submission
// asks for is stored so a held message can still get its key at delivery —
// where the context is checked again (isSubmitKey).
export const possibleSubmitKey = (agent: string | null | undefined, key: string) => submitKeysFor(agent, { working: true }).includes(key) || submitKeysFor(agent, { working: false }).includes(key)
