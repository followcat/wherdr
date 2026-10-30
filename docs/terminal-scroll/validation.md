# Terminal scroll: validation log

## Baseline (T00)

| Item | Value |
|---|---|
| Base SHA | `1089e5339937beff7806541724c8166d1a161ac8` (`mobile` HEAD at branch creation) |
| Branch | `fix/terminal-scroll-v2` (worktree `wherdr-prs/scroll-v2`) |
| Node / npm | v24.11.1 / 11.6.2 (repo declares `>=22`) |
| xterm | `^5.5.0` (lockfile-resolved) |
| Browsers | chromium-1243 present; **WebKit not installed → webkit-phone specs NOT RUN** |

### Existing failures / contradictions at baseline

- `tests/e2e/terminal-touch-beta.spec.ts` asserted tap→focus in three places:
  contradicted the mobile contract "a simple tap never opens the keyboard".
  Aligned in T01.
- Unit/component baseline green: 70 passed, 0 failed.

## Commits

| SHA | Scope |
|---|---|
| `c2b4da1` | T00 baseline docs, fault knobs, momentum bench |
| `7a9c1dc` | T01 gesture contracts: dragStart cancels long-press; tap never focuses |
| `839df12` | codex fix: boundary frame flag, FIFO consume ordering, lpTimer type |
| `19eb855` | T02 v2 ledger: scroll.cmd stages, phase cancel, per-phase acks |
| `090e5f0` | T03 backpressure-aware stdin writer |
| `2f5402e` | T04 analytic momentum integral |
| `1aff59e` | T04 rowHeight cached per geometry version |
| `dd4d05b` | T05 frameStats (frames/bytes/parseMs, non-reactive) |
| `980abdc` | T06 honest copy failure reporting |
| `db380e1` | T07 consumeDelayMs / noFrameAtBoundary e2e coverage |
| `78e0d20` | codex fix: honest ledger under backpressure, bounded writer, contrib netting |

## Results

- Unit/relay: `terminalTouch` 22, `terminalTouchRelay` 14, `scrollPhaseCancel` 5,
  `terminalWriter` 4, `touchTap` 7 — all green after every change.
- E2E `terminal-touch-beta` on chromium-phone: **21/21** (includes the new
  copy-mode gap, native-tap, delayed-consume and boundary-frame cases).
- `vue-tsc --noEmit` clean; `npm run build` clean.

## Momentum integrator A/B (tests/bench/momentum.mjs, n=30 each)

| Rate | Before (Euler) | After (analytic) |
|---|---|---|
| 60 Hz | 555.7 px | 575.4 px |
| 90 Hz | 561.1 px | 574.2 px |
| 120 Hz | 563.7 px | 573.6 px |
| spread | 8.0 px (1.4%) | 1.8 px (0.31%) |

Gate was ≤1% continuous: met. No parameter change — τ still 240ms.

## Codex review

Two rounds ran per the task contract:

1. After `7a9c1dc`: 3 findings (typecheck regression `lpTimer = null`,
   partial boundary movement flagged as no-frame, delayed events could
   overtake the pending head). All fixed in `839df12`.
2. After `090e5f0`: 2×P1 + 5×P2 + 1×P3 — out-of-scope `toChild` in
   `resizePane`, unbounded writer queue, `submitted`/`delivered` advanced
   before the real stream write, FIFO attribution broken on direction
   reversal and on non-scroll cancels, early queue dropped callbacks,
   release stranded behind a backpressured tail, drain-listener leak,
   reentrant `cancelWhere`. All fixed in `78e0d20`.
3. Final review after `ddd3020` (in-memory reproductions): contribution log
   pre-netting broke phase-cancel accounting (`+5 drag, -3 momentum, cancel
   → wrote 5, acked 2`), merged-path delivery still advanced before stream
   submission, a failed write reported `flushed`, writer overflow could
   evict protected input, pacer left phantom in-flight ticks on reentrant
   cancel, contribution log ignored the throttle's line cap, and the
   boundary spec asserted a decision flag rather than the emitted act.
   Fixed in `cef8e80` + `c81b38b`: raw signed contribution log with
   flush-time attribution reported at `onSubmit`, `writeFailed` stage,
   expendable-vs-protected eviction, per-tick in-flight accounting, log
   cleared at flush (post-flush net is zero), `frame_sent` report-back in
   the fixture, atomic pending+offset read. E2E re-run: 21/21 green;
   unit suites 26/26 (writer incl. eviction cases).
4. Upstream-readiness review (external, `wherdr-prs/scroll-v2-review/`):
   four real-PassThrough probes reproduced three gaps — cancels and TTL
   could not revoke scroll chunks already queued in the writer; a full
   queue silently deleted protected input; phased cancels were sent
   without capability negotiation (an older server full-cancels and
   wipes drag work). Fixed in `5fabf73`: queued chunks carry tag+deadline
   (`cancelWhere`, expiry on pump and on early replay), protected input
   is never dropped (a pipe stalled past `maxProtected` dies loudly),
   `web.capabilities` advertises `scroll:2`, unproven peers get no
   phase-cancel, and a phase cancel no longer bumps the gesture epoch.
   New `tests/scrollWriterCancel.test.ts` pins all of it: relay+writer
   suites 35/35, chromium-phone e2e 21/21.
5. Follow-up review of `5fabf73` (`followup-29db92b/`): the same probes
   passed, but three queue boundaries were still open. Fixed in this
   branch: the pre-start `early` queue now honors the same cancel/phase/
   direction predicates as the writer (a full cancel before spawn no
   longer replays scrolls on attach); the merged flush emits phase-pure
   sub-batches, each tagged with its own deadline (momentum 240 ms, drag
   800 ms) — a phase cancel drops the momentum share without taking drag
   lines, and a stalled writer expires the tail itself; and
   `peerScrollV2` resets on every `connect()` — capability evidence is
   per-connection. Three new relay probes cover all of it: 33/33 unit,
   21/21 chromium-phone e2e.

## NOT RUN / limitations

- **webkit-phone, iOS Safari, Android real devices**: not executed. The tap/
  focus contract was verified only under Chromium's synthetic + CDP touch.
  (The 21-case spec contains `@webkit-phone`-tagged cases but only the
  chromium-phone project was run.)
- Frame-silence simulation is partial: the fake CLI repaints on a 150 ms
  ticker regardless, so "frames arriving but nothing applied" is modeled
  only through `consumeDelayMs`/`noFrameAtBoundary`, not a dead stream.
- `scroll.ack` phase attribution on the merged path is FIFO over same-sign
  contributions — exact for typical bursts, approximate across interleaved
  reversals (opposite-sign residue is dropped at flush, matching the
  throttle's own discard).
- A write stalled past the 1500 ms child-kill window can still lose the
  `terminal.release` line; bounded and documented, not solved.
- Performance deltas other than the integrator spread were not A/B'd
  against a real device; `frameStats` exists for that follow-up.
