// Devin's screen (v3000.x): its native queue above the boxed input field,
// the messages it echoes "❭" in the scrollback, and its "↵ send now" flush.
// Captured on Devin 3000.11.234 (probe workspace).
import { describe, expect, it } from 'vitest'
import { parseDevinScreen } from '../server/utils/devinScreen'

const WORKING_QUEUE = `❭ Use your exec tool to run: sleep 90. Then reply done.

 ✓ sleep 90 Running in background shell c05304

⣀⡀ Thinking · 48s (esc twice to interrupt)
── 1 queued ─────────────────────────────────── ↑ edit · ↵ send now ──
○ CTRLENTER-QUEUED probe message
─── Run a 60-Second Sleep Command ───
❭ Press Enter to send queued messages now
───
SWE-2 Max · 1 shell ↓                  Context: 16k / 262k tokens (6%)
`

const WORKING_QUEUE2 = `❭ QUEUEPROBE second steer test

⠀⠸ Thinking · 29s (esc twice to interrupt)
── 2 queued ────────────────────────────────── ↑ edit · ↵ send now ──
○ UNQUEUE-TEST first msg
○ UNQUEUE-TEST second msg
─── Run a 60-Second Sleep Command ───
❭ Press Enter to send queued messages now
───
SWE-2 Max · 1 shell ↓
`

const COMPACT_QUEUE = `❭ /compact

⠀⣠ Compacting…

 ⏺ /tmp
── 1 queued ────────────────────────────────── ↑ edit · ↵ send now ──
○ DURING-COMPACT probe message
─── Run a 60-Second Sleep Command ───
❭ Ask Devin to build features, fix bugs, or work on your code
───
SWE-2 Max
`

const WORKING_STEER = `❭ Use your exec tool to run: sleep 90. Then reply done.

 ✓ sleep 90 Running in background shell c05304
 ✓ Read shell c05304

❭ STEER-AFTER-QUEUE test message

⣀⡀ Thinking · 48s (esc twice to interrupt)
─── Run a 60-Second Sleep Command ───
❭ Guide Devin while it works
───
SWE-2 Max · 1 shell ↓
`

const IDLE = ` done

 ⏺ /tmp
─── Run a 60-Second Sleep Command ───
❭ Ask Devin to build features, fix bugs, or work on your code
───
SWE-2 Max                          Use /clear to start a fresh conversation
`

// Entries and echoes wider than the pane wrap onto indented continuation
// rows — captured shape (2-cell indent, no marker).
const WRAPPED_QUEUE = `❭ QUEUEPROBE second steer test

⣄⠀ Thinking · 5s (esc twice to interrupt)
── 2 queued ────────────────────────────────── ↑ edit · ↵ send now ──
○ WRAPPROBE wrapped-queued-entry-wrapped-queued-entry-wrapped-queued-
  entry-wrapped-queued-entry- TAIL
○ UNQUEUE-TEST second msg
─── Run a 60-Second Sleep Command ───
❭ Press Enter to send queued messages now
───
SWE-2 Max · 1 shell ↓
`

const WRAPPED_SENT = `❭ WRAPPROBE wrapped-queued-entry-wrapped-queued-entry-wrapped-queued-
  entry-wrapped-queued-entry- TAIL

⣄⠀ Typing · 5s (esc twice to interrupt)
─── Run a 60-Second Sleep Command ───
❭ Guide Devin while it works
───
SWE-2 Max · 1 shell ↓
`

const DIALOG = `❭ Use your exec tool to run: sleep 45. Nothing else.

 ⏺ Running command
 └ $ sleep 45

❭ Allow       ← ◼◼◼◼ → Once     Exec(sleep)
  Bypass mode
  Deny

↑↓ select · ←→ scope · e edit · ↵ confirm · esc cancel
`

describe('Devin screen', () => {
  it('reads its native queue above the boxed field, while working', () => {
    const s = parseDevinScreen(WORKING_QUEUE)!
    expect(s.queued).toEqual(['CTRLENTER-QUEUED probe message'])
    expect(s.sendNow).toBe(true)
    expect(s.sent).toBe('Use your exec tool to run: sleep 90. Then reply done.')
    expect(s.shell).toBeNull()
  })

  it('reads several queued messages in order', () => {
    const s = parseDevinScreen(WORKING_QUEUE2)!
    expect(s.queued).toEqual(['UNQUEUE-TEST first msg', 'UNQUEUE-TEST second msg'])
    expect(s.sendNow).toBe(true)
    expect(s.sent).toBe('QUEUEPROBE second steer test')
  })

  it('reads the queue while compacting (field still on screen)', () => {
    const s = parseDevinScreen(COMPACT_QUEUE)!
    expect(s.queued).toEqual(['DURING-COMPACT probe message'])
    expect(s.sendNow).toBe(true)
    expect(s.sent).toBe('/compact')
  })

  it('steered message: echoed in the scrollback, nothing queued', () => {
    const s = parseDevinScreen(WORKING_STEER)!
    expect(s.queued).toEqual([])
    expect(s.sendNow).toBeUndefined()
    expect(s.sent).toBe('STEER-AFTER-QUEUE test message')
  })

  it('idle: no queue, no sendNow', () => {
    const s = parseDevinScreen(IDLE)!
    expect(s.queued).toEqual([])
    expect(s.sendNow).toBeUndefined()
    expect(s.sent).toBeNull()
  })

  it('a wrapped entry still parses, joined with its continuation', () => {
    const s = parseDevinScreen(WRAPPED_QUEUE)!
    expect(s.queued).toEqual([
      'WRAPPROBE wrapped-queued-entry-wrapped-queued-entry-wrapped-queued- entry-wrapped-queued-entry- TAIL',
      'UNQUEUE-TEST second msg',
    ])
    expect(s.sendNow).toBe(true)
    expect(s.sent).toBe('QUEUEPROBE second steer test')
  })

  it('a wrapped sent echo keeps its continuation too', () => {
    const s = parseDevinScreen(WRAPPED_SENT)!
    expect(s.queued).toEqual([])
    expect(s.sent).toBe('WRAPPROBE wrapped-queued-entry-wrapped-queued-entry-wrapped-queued- entry-wrapped-queued-entry- TAIL')
  })

  it('permission dialog: no composer field on screen → null', () => {
    expect(parseDevinScreen(DIALOG)).toBeNull()
  })

  it('no field anchored → null, never a guess', () => {
    expect(parseDevinScreen('')).toBeNull()
    expect(parseDevinScreen('❭ a scrolled-off message\n   reply text')).toBeNull()
  })
})
