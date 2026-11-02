# Terminal scroll: implementation notes

Scope: the Terminal view's touch scrolling — especially opaque TUIs where no
Conversation exists. The architecture stays Herdr-owned viewport → real ANSI
frames → xterm; no persistent history DOM, no predictive screen transform,
no arrow-key fallback.

## Units — never interchange

- **CSS px**: finger movement in the browser.
- **native-row**: Herdr history lines (`terminal.scroll lines:N` honored).
- **wheel-tick**: a mouse-mode app gets one wheel report per command and
  decides what it means (a row, an item, a page). Never assume 1 tick = 1 row.

## Delivery facts — never all called "ack"

`accepted` (queued server-side) → `submitted` (written to the child's stdin)
→ `pipeFlushed` (write callback/drain) → `frameReceived`/`xtermParsed`/
`renderObserved`. Only a future Herdr capability could report `nativeApplied`.
Frames arriving prove liveness only — a repainting TUI is not a consuming TUI.

## Cancellation

- **full cancel**: new gesture, explicit reversal, input/paste, hidden,
  disconnect, close, feature off, copy mode. Bumps `touchEpoch`, clears
  uncommitted work at every layer.
- **phase cancel (momentum-only)**: ends the glide without deleting valid drag.
  V1 cannot express it — bounded TTL is the fallback; never drop real drags.
- Natural momentum end ≠ cancel: stop generating, let the valid short tail
  drain; do not abort in-flight commands.

## Routing modes (capability ≠ live mode)

`mouseTransportSupported` (server capability) vs `applicationMouseMode`
`'on' | 'off' | 'unknown'`. Replayed frames not showing a mouse-mode sequence
are NOT proof of "off"; unknown keeps the conservative wheel-report route.

## Wire protocol v2 (as implemented)

Client → server `terminal.scroll` adds `v:2`, `id` (per-connection monotonic),
`phase: 'drag' | 'momentum'`. Old servers ignore the fields; old clients get
the unchanged contract — no handshake, version is per message.

Server → client:
- `scroll.ack {epoch, phase, lines}` — delivered lines per (epoch, phase),
  emitted after the next relayed frame. V1 clients ignore `phase` and sum.
- `scroll.cmd {epoch, id, phase, stage}` — per-command facts for v2 peers:
  `submitted` = the chunk actually entered the child stdin stream (inside
  the writer queue does NOT count), `flushed` = the stream write callback.
- `touch.cancel {phase?: 'momentum'}` — phase form drops only the expendable
  momentum tail (pacer queue + merged contributions); omitted = full cancel.

## Server internals

- `terminalWriter` — bounded (256) FIFO for child stdin. `write() === false`
  never resends; the tail queues until `drain`. Release disposes the queue
  then writes directly so teardown can't strand it.
- `mergedContrib` — mirrors the throttle's net; opposite pushes cancel
  oldest-first; flushed lines attribute back to (epoch, phase) FIFO.
- `touchScrollPacer.cancelWhere` / `scrollThrottle.cancelTagged` — phase
  cancels reach queued work only; the send window and in-flight are intact.

## Rollback

- Whole feature: `smoothTouchScrolling` localStorage flag (existing beta
  toggle) restores the legacy non-smooth path instantly, per client.
- This branch: `git revert` the commit range `c2b4da1..` or reset to
  `1089e53`; no data migration exists — all state is in-memory per session.
- The v2 wire fields are additive: an older server build works unchanged
  with a newer client (it never receives `scroll.cmd` and falls back to
  `scroll.ack` pacing) and vice versa.
