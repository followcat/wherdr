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
