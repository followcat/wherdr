// Devin's /usage, /context and /session-stats: the answer is printed into the
// terminal, so wherdr reads it off the screen and turns the block into a card
// (shared/devinCommandCards.ts). Fixtures are real screens, anonymized.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { devinCardBaseline, devinCardBlock, devinCardCommand, devinCardNew, devinCardText, devinEchoCount, parseDevinCard } from '../shared/devinCommandCards'
import type { DevinCardCommand } from '../shared/types'

const screen = (name: string) => readFileSync(new URL(`./fixtures/core-screens/${name}.txt`, import.meta.url), 'utf8')
const cardOf = (name: string, command: DevinCardCommand) => {
  const block = devinCardBlock(screen(name), command)
  expect(block?.complete).toBe(true)
  return parseDevinCard(command, block!.lines)
}

const USAGE_SESSION = [
  { label: 'Agent messages', value: '1 message' },
  { label: 'Input tokens', value: '5452 tokens' },
  { label: 'Output tokens', value: '28 tokens' },
  { label: 'Cached input tokens', value: '7936 tokens' },
  { label: 'Activity', value: '1 turn · 0 tool calls · 0 files · 0 commands' },
  { label: 'Tokens', value: '13k in · 28 out (~13k per turn)' },
  { label: 'Model', value: 'SWE-2 Max' },
]
const STATS_ROWS = [
  { label: 'Agent messages', value: '1 message' },
  { label: 'Input tokens', value: '5452 tokens' },
  { label: 'Output tokens', value: '28 tokens' },
  { label: 'Cached input tokens', value: '7936 tokens' },
]

describe('Devin card commands', () => {
  it('takes the three commands, whitespace aside, and nothing else', () => {
    expect(devinCardCommand('/usage')).toBe('/usage')
    expect(devinCardCommand(' /context\n')).toBe('/context')
    expect(devinCardCommand('/session-stats')).toBe('/session-stats')
    for (const text of ['/usage now', '/model', '/shortcuts', 'usage', '/usage /context', '']) {
      expect(devinCardCommand(text)).toBeNull()
    }
  })
})

describe('the echo and its block on the screen', () => {
  it('reads the newest echo of the command, never an older one higher up', () => {
    // Three echoes: one from an earlier turn stays higher up, two were sent here.
    expect(devinEchoCount(screen('devin-usage-twice'), '/usage')).toBe(3)
    expect(cardOf('devin-usage-twice', '/usage')).toMatchObject({
      windows: [{ label: 'Daily', percent: 32 }, { label: 'Weekly', percent: 21 }],
      session: [{ label: 'Agent messages', value: '3 messages' }, { label: 'Input tokens', value: '20414 tokens' }, { label: 'Output tokens', value: '963 tokens' }, { label: 'Cached input tokens', value: '20544 tokens' }, { label: 'Activity', value: '2 turns · 2 tool calls · 0 files · 2 commands' }, { label: 'Tokens', value: '27k in · 367 out (~14k per turn)' }, { label: 'Model', value: 'SWE-2 Max' }],
    })
  })

  it('ends the block at the frame when Devin is idle', () => {
    const block = devinCardBlock(screen('devin-usage-turn'), '/usage')!
    expect(block.complete).toBe(true)
    expect(block.lines.at(-1)).toBe(' Model                SWE-2 Max')
    expect(block.lines.join('\n')).not.toMatch(/●|❭|─{5}|Context:/)
  })

  it('ends a /context block mid-turn at the spinner, between a tool call and the next line', () => {
    const block = devinCardBlock(screen('devin-context-midturn'), '/context')!
    expect(block.complete).toBe(true)
    expect(block.lines.some(l => /Thinking|esc twice|Guide Devin/.test(l))).toBe(false)
    expect(block.lines.at(-1)).toMatch(/Total/)
  })

  it('stops a /session-stats block mid-turn before the assistant text that follows it', () => {
    const block = devinCardBlock(screen('devin-session-stats-midturn'), '/session-stats')!
    expect(block.complete).toBe(true)
    expect(block.lines.join('\n')).not.toMatch(/I'll first check|find \/usr/)
    expect(block.lines.at(-1)).toMatch(/Total/)
  })

  it('stops a /usage block mid-turn before the assistant text and the approval dialog', () => {
    const block = devinCardBlock(screen('devin-usage-midturn'), '/usage')!
    expect(block.complete).toBe(true)
    expect(block.lines.join('\n')).not.toMatch(/11,027 files|Running command|Allow/)
  })

  it('keeps the blocks between tool-call lines of a 151-column screen, and stops at them', () => {
    expect(devinEchoCount(screen('devin-tool-lines-151'), '/context')).toBe(1)
    const context = devinCardBlock(screen('devin-tool-lines-151'), '/context')!
    expect(context.lines.join('\n')).not.toMatch(/sqlite3/)
    expect(context.lines.at(-1)).toMatch(/Total/)
    const stats = devinCardBlock(screen('devin-tool-lines-151'), '/session-stats')!
    expect(stats.lines.join('\n')).not.toMatch(/sqlite3|Canceled/)
  })

  it('is null when the screen has no echo of the command', () => {
    expect(devinCardBlock(screen('devin-usage-fresh'), '/context')).toBeNull()
  })

  it('is incomplete while its last line is still being written', () => {
    const full = screen('devin-context-turn')
    const block = devinCardBlock(full.slice(0, full.indexOf(' ● Tools')) + ' ● Tools  ....▄▄▄', '/context')!
    expect(block.complete).toBe(false)
    expect(block.lines.at(-1)).toMatch(/System prompt/)
  })

  it('is incomplete while the screen ends on the rule of a Total row not drawn yet', () => {
    const full = screen('devin-context-turn')
    const block = devinCardBlock(full.slice(0, full.indexOf('   Total')), '/context')!
    expect(block.complete).toBe(false)
    expect(block.lines.at(-1)).toMatch(/Free/)
  })

  it('is incomplete while only the echo and a spinner are on the screen', () => {
    expect(devinCardBlock('❭ /context\n⠸⠀ Thinking · 1s (esc twice to interrupt)\n', '/context')).toEqual({ lines: [], complete: false })
  })

  it('is incomplete while the screen ends before the block does', () => {
    const block = devinCardBlock(' Usage\n❭ /usage\n Usage\n Daily   ■■■■  21% used  · resets in 5h 3m\n', '/usage')
    expect(block).toEqual({ lines: [' Usage', ' Daily   ■■■■  21% used  · resets in 5h 3m'], complete: false })
  })
})

describe('what was printed since a command was sent', () => {
  const FRAME = ['', ' ● /home/user/acme-shop', '─────────────', '❭ Ask Devin to build features, fix bugs, or work on your code', '─────────────', 'SWE-2 Max']
  const block = ['❭ /usage', ' Usage', ' Daily   ■■■■  57% used  · resets in 3h 2m', ' Weekly  ■■■■  34% used  · resets Nov 22, 4:00 PM (UTC+8)']

  it('sees an identical block printed again, though the older echo scrolled off the screen', () => {
    const before = ['wrapped task output', ...block, ...FRAME].join('\n')
    const now = [...block.slice(1), ...block, ...FRAME].join('\n')
    expect(devinEchoCount(now, '/usage')).toBe(devinEchoCount(before, '/usage'))
    expect(devinCardNew(now, '/usage', devinCardBaseline(before, '/usage'))).toBe(true)
  })

  it('sees nothing new while the screen only shows the same output', () => {
    const screen = [...block, ...FRAME].join('\n')
    expect(devinCardNew(screen, '/usage', devinCardBaseline(screen, '/usage'))).toBe(false)
  })

  it('sees a block printed after a reply still being written, whose last line grew', () => {
    const before = ['❭ /usage', ' Usage', ' Daily   ■■  49% used  · resets in 3h 9m', 'I will check the folder and', ...FRAME].join('\n')
    const now = [' Usage', ' Daily   ■■  49% used  · resets in 3h 9m', 'I will check the folder and then count the entries', ...block, ...FRAME].join('\n')
    expect(devinEchoCount(now, '/usage')).toBe(devinEchoCount(before, '/usage'))
    expect(devinCardNew(now, '/usage', devinCardBaseline(before, '/usage'))).toBe(true)
    const grown = [' Usage', ' Daily   ■■  49% used  · resets in 3h 9m', 'I will check the folder and then count the entries', ...FRAME].join('\n')
    expect(devinCardNew(grown, '/usage', devinCardBaseline(before, '/usage'))).toBe(false)
  })

  it('sees nothing new when the screen still ends on the echo it showed before the send', () => {
    const screen = ['output one', 'output two', 'output three', '❭ /usage', ...FRAME].join('\n')
    expect(devinCardNew(screen, '/usage', devinCardBaseline(screen, '/usage'))).toBe(false)
  })

  it('ignores a spinner line that changes while the turn runs', () => {
    const before = [...block, '⠸⠀ Thinking · 2s (esc twice to interrupt)', ...FRAME].join('\n')
    const now = [...block, '⠙⠀ Thinking · 9s (esc twice to interrupt)', ...FRAME].join('\n')
    expect(devinCardNew(now, '/usage', devinCardBaseline(before, '/usage'))).toBe(false)
  })
})

describe('the parsed card', () => {
  it('reads /usage before any turn: the two windows and the note', () => {
    expect(cardOf('devin-usage-fresh', '/usage')).toEqual({
      command: '/usage',
      kind: 'usage',
      windows: [
        { label: 'Daily', percent: 29, reset: 'resets in 4h 41m' },
        { label: 'Weekly', percent: 20, reset: 'resets Nov 22, 4:00 PM (UTC+8)' },
      ],
      session: [],
      note: 'No usage yet in this session.',
    })
  })

  it('reads /usage after a turn: the windows and the session rows, without the frame', () => {
    expect(cardOf('devin-usage-turn', '/usage')).toEqual({
      command: '/usage',
      kind: 'usage',
      windows: [
        { label: 'Daily', percent: 30, reset: 'resets in 4h 39m' },
        { label: 'Weekly', percent: 20, reset: 'resets Nov 22, 4:00 PM (UTC+8)' },
      ],
      session: USAGE_SESSION,
      note: null,
    })
  })

  it('reads /usage mid-turn', () => {
    expect(cardOf('devin-usage-midturn', '/usage')).toMatchObject({
      kind: 'usage',
      windows: [{ label: 'Daily', percent: 31, reset: 'resets in 4h 38m' }, { label: 'Weekly', percent: 21 }],
      session: USAGE_SESSION,
    })
  })

  it('reads /context: the model, each category with its value, and the total', () => {
    expect(cardOf('devin-context-turn', '/context')).toEqual({
      command: '/context',
      kind: 'context',
      model: 'swe-2-max',
      categories: [
        { label: 'System prompt', value: '5.8k', percent: 2 },
        { label: 'Tools', value: '7.6k', percent: 3 },
        { label: 'Messages', value: '7', percent: 0 },
        { label: 'Free', value: '248.6k', percent: 95 },
      ],
      total: { used: '13.4k', limit: '262k', percent: 5 },
    })
    expect(cardOf('devin-context-midturn', '/context')).toMatchObject({ categories: [{}, {}, { label: 'Messages', value: '36' }, {}], total: { used: '13.4k', limit: '262k', percent: 5 } })
  })

  it('reads /context between tool-call lines on a 151-column screen', () => {
    expect(cardOf('devin-tool-lines-151', '/context')).toMatchObject({
      model: 'swe-2-max',
      categories: [
        { label: 'System prompt', value: '7.4k', percent: 3 },
        { label: 'Tools', value: '9.8k', percent: 4 },
        { label: 'Messages', value: '22.3k', percent: 9 },
        { label: 'Free', value: '222.5k', percent: 85 },
      ],
      total: { used: '39.5k', limit: '262k', percent: 15 },
    })
  })

  it('reads /session-stats: the rows, the models with their share, and the total', () => {
    const stats = {
      command: '/session-stats',
      kind: 'stats',
      rows: STATS_ROWS,
      models: [{ label: 'SWE-2 Max', value: '13k', percent: 100 }],
      total: '13k tokens',
    }
    expect(cardOf('devin-session-stats-turn', '/session-stats')).toEqual(stats)
    expect(cardOf('devin-session-stats-midturn', '/session-stats')).toEqual(stats)
  })

  it('reads /session-stats on a 151-column screen', () => {
    expect(cardOf('devin-tool-lines-151', '/session-stats')).toEqual({
      command: '/session-stats',
      kind: 'stats',
      rows: [
        { label: 'Agent messages', value: '1 message' },
        { label: 'Input tokens', value: '3221 tokens' },
        { label: 'Output tokens', value: '50 tokens' },
        { label: 'Cached input tokens', value: '10176 tokens' },
      ],
      models: [
        { label: 'SWE-2 Max', value: '373k', percent: 96 },
        { label: 'Unknown model', value: '14k', percent: 4 },
      ],
      total: '387k tokens',
    })
  })

  it('never carries the session id of /session-stats', () => {
    const card = cardOf('devin-session-stats-turn', '/session-stats')
    expect(JSON.stringify(card) + devinCardText(card)).not.toContain('4f1c9a2e')
  })

  it('shows the message Devin prints before any turn, as text', () => {
    expect(cardOf('devin-context-fresh', '/context')).toEqual({ command: '/context', kind: 'text', lines: ['No context usage available yet. Send a message first.'] })
    expect(cardOf('devin-session-stats-fresh', '/session-stats')).toEqual({ command: '/session-stats', kind: 'text', lines: ['No turns completed yet in this session.'] })
  })
})

describe('a block that does not parse', () => {
  it('falls back to its own text: bar glyphs dropped, spaces kept as two, rules left out', () => {
    expect(cardOf('devin-context-unknown', '/context')).toEqual({
      command: '/context',
      kind: 'text',
      lines: [
        'Context usage  swe-2-max',
        'System prompt  7.4k tokens  3%',
        'Tools  9.8k tokens  4%',
        'Free  222.5k tokens  85%',
        'Total  39.5k of 262k tokens  15%',
      ],
    })
  })

  it('still scrubs a session id from its text', () => {
    expect(parseDevinCard('/session-stats', ['Session stats  4f1c9a2e-7b3d-4e8a-9c61-2d5b8e0f7a13', 'Something new about the session'])).toEqual({
      command: '/session-stats',
      kind: 'text',
      lines: ['Session stats', 'Something new about the session'],
    })
  })
})

describe('the plain text of a card', () => {
  it('carries the figures of the card, for search and copy', () => {
    expect(devinCardText(cardOf('devin-usage-turn', '/usage'))).toContain('Daily 30% used · resets in 4h 39m')
    expect(devinCardText(cardOf('devin-context-turn', '/context'))).toContain('Total 13.4k/262k 5%')
    expect(devinCardText(cardOf('devin-session-stats-turn', '/session-stats'))).toContain('SWE-2 Max 13k 100%')
  })
})
