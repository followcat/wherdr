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

- `tests/e2e/terminal-touch-beta.spec.ts` asserts tap→focus in three places
  (lines ~115, ~187, ~283): contradicts the mobile contract "a simple tap never
  opens the keyboard" (component tests assert `blur`). F07 — aligned in T01.
- Unit/component baseline green: `terminalTouch` 21, `terminalTouchRelay` 13,
  `terminalScrollPosition` (mixed file), `stateReady`, `TerminalTouchBeta`,
  `SocketWake`, `touchTap` — 70 passed, 0 failed.

### Momentum integrator baseline (tests/bench/momentum.mjs, n=30 each)

| Rate | Momentum distance |
|---|---|
| 60 Hz | 555.7 px |
| 90 Hz | 561.1 px |
| 120 Hz | 563.7 px |

Euler stepping undercounts at lower refresh rates (~1.4% spread). T04 replaces
it with analytic integration; the acceptance gate is ≤1 final quantized unit
(≤1% continuous) across rates.

### Fault fixture (fake Herdr)

`e2e.touch_scroll` gained the §10.3 knobs used by later tasks:
`consumeDelayMs`, `wheelRowsPerTick`, `noFrameAtBoundary`, plus `applied`/
`pending`/`frame` in the response so specs can separate submission from
consumption. With `consumeDelayMs=0` behavior is unchanged.
