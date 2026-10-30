# RFC: scroll delivery semantics Herdr could expose

This is a proposal only — nothing here was implemented on the Herdr side.

## What wherdr can measure today

The wherdr server knows when a scroll command was **written to the CLI
stdin** and when the write callback fired. It cannot know whether the
application consumed the input — a repainting TUI is not a consuming TUI.
The client therefore treats frames strictly as liveness.

## What would close the loop

`terminal.scroll` is fire-and-forget. Two additions would let wherdr (and
any future client) distinguish *submitted* from *applied*:

1. **Command ids.** Accept an optional `id` field on `terminal.scroll` and
   `terminal.input`, echo it in a `terminal.input.applied` message once the
   input has been delivered to the child process (or, for mouse-report mode,
   once the wheel report was written to the pane's pty). No semantics beyond
   "left our hands" — consumption by the app remains unknowable and that's
   honest.

2. **Applied cursor for history scrolls.** For the `lines:N` history path,
   Herdr knows the resulting scroll offset; returning it (`scroll.applied
   {offset}`) would let the client settle its ledger exactly instead of
   inferring "probably applied" from a later frame.

## What is deliberately NOT requested

- Consumption acknowledgment from the *application* (impossible for opaque
  TUIs — the app is ANSI; there is nothing to ack).
- Input replay: wherdr's queues TTL-expire and phase-cancel locally; the
  wire never replays submitted bytes.

## Backward compatibility

Both fields are additive; older Herdr versions simply never emit them and
clients fall back to the existing frame-based heuristics.
