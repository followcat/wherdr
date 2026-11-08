// v3 screen reading on herdr-core, fixture by fixture: each realistic Claude Code / Codex
// screen in fixtures/core-screens/ is checked for the status and interaction derived when
// core reports nothing, the card preview, and the choices offered (with the keys sent).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCoreScreens, readCoreScreen } from '../server/utils/coreScreen'
import { createCorePreviews } from '../server/utils/corePreview'
import { coreChoose } from '../server/utils/coreChoose'
import type { Pane } from '../shared/types'
import { createInteractionWindow } from '../app/utils/interactionWindow'

const screen = (name: string) => readFileSync(new URL(`./fixtures/core-screens/${name}.txt`, import.meta.url), 'utf8')
const settle = () => new Promise(r => setTimeout(r, 5))

interface Case {
  name: string
  /** Status derived from the screen when core reports none (null: left to core). */
  status: 'working' | 'blocked' | 'idle' | null
  interaction: NonNullable<Pane['interaction']>
  /** Card subtitle when the conversation gives no reply (Codex errors take precedence). */
  preview: string
  error?: string
  question?: string
  options?: string[]
  /** Labels of the options that open a free-text field. */
  free?: string[]
}

const CODEX_LIMIT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 8th, 2026 2:52 PM."
const CODEX_INTERRUPTED = 'Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to report the issue.'

const CASES: Case[] = [
  // Claude Code
  { name: 'claude-idle', status: 'idle', interaction: 'input', preview: 'Run /init to create a CLAUDE.md file with instructions for Claude' },
  { name: 'claude-working', status: 'working', interaction: 'working', preview: '✻ Pondering… (23s · ↓ 1.4k tokens · esc to interrupt)' },
  { name: 'claude-working-spinner', status: 'working', interaction: 'working', preview: "⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work" },
  { name: 'claude-finished', status: 'idle', interaction: 'input', preview: 'Added six cases for the date parser; all tests pass.' },
  {
    name: 'claude-question', status: 'blocked', interaction: 'native', preview: '5. Chat about this',
    question: 'Which database should the service use?',
    options: ['PostgreSQL', 'SQLite', 'MongoDB', 'Type something.', 'Chat about this'], free: ['Type something.'],
  },
  {
    name: 'claude-permission', status: 'blocked', interaction: 'native', preview: '3. No, and tell Claude what to do differently (esc)',
    question: 'Do you want to proceed?',
    options: ['Yes', "Yes, and don't ask again for npm run build commands in ~/projects/demo-app", 'No, and tell Claude what to do differently (esc)'],
  },
  {
    name: 'claude-trust', status: 'blocked', interaction: 'native', preview: '2. No, exit',
    question: 'Quick safety check: Is this a project you created or one you trust? (Like your',
    options: ['Yes, I trust this folder', 'No, exit'],
  },
  // The footer's "esc to cancel" hides the field: nothing is derived without a core status.
  { name: 'claude-usage-limit', status: null, interaction: 'unknown', preview: 'Continuing automatically at Nov 6, 9am · esc to cancel · /usage-credits to continue now' },
  { name: 'claude-usage-limit-inline', status: 'idle', interaction: 'input', preview: '/upgrade to increase your usage limit.' },
  { name: 'claude-queued', status: 'working', interaction: 'working', preview: '❯ Press up to edit queued messages' },
  { name: 'claude-interrupted', status: 'idle', interaction: 'input', preview: '⎿  Interrupted · What should Claude do instead?' },
  // Codex
  { name: 'codex-idle', status: 'idle', interaction: 'input', preview: '/status - show current session configuration' },
  { name: 'codex-working', status: 'working', interaction: 'working', preview: '• Working (18s • esc to interrupt)' },
  { name: 'codex-finished', status: 'idle', interaction: 'input', preview: '• Added six cases for the date parser; all tests pass.' },
  {
    name: 'codex-approval', status: 'blocked', interaction: 'native', preview: 'Press enter to confirm or esc to cancel',
    question: 'Would you like to run the following command?',
    options: ['Yes, proceed (y)', "Yes, and don't ask again for this command (p)", 'No, and tell Codex what to do differently (esc)'],
  },
  {
    name: 'codex-trust', status: 'blocked', interaction: 'native', preview: 'Press enter to continue',
    question: 'Since this folder is version controlled, you may wish to allow Codex to work in this folder without asking for approval.',
    options: ['Yes, allow Codex to work in this folder without asking for approval', 'No, ask me to approve edits and commands'],
  },
  { name: 'codex-usage-limit', status: 'idle', interaction: 'input', preview: CODEX_LIMIT, error: CODEX_LIMIT },
  { name: 'codex-queued', status: 'working', interaction: 'working', preview: '⌥ + ↑ edit' },
  { name: 'codex-interrupted', status: 'idle', interaction: 'input', preview: CODEX_INTERRUPTED, error: CODEX_INTERRUPTED },
]

const agentOf = (c: Case) => c.name.split('-')[0]!
const menus = CASES.filter(c => c.options)
const pane = (c: Case, extra: Partial<Pane> = {}) =>
  ({ id: c.name, workspace: 'w', coreAddress: `m/${c.name}`, agent: agentOf(c), status: 'unknown', ...extra }) as Pane

describe('readCoreScreen on recorded screens (no core status)', () => {
  it.each(CASES)('$name', (c) => {
    const r = readCoreScreen(screen(c.name), agentOf(c), 'unknown')
    expect(r.status).toBe(c.status)
    expect(r.interaction).toBe(c.interaction)
    if (!c.options) {
      expect(r.choices).toBeNull()
      return
    }
    expect(r.choices?.question).toBe(c.question)
    expect(r.choices?.options.map(o => o.label)).toEqual(c.options)
    expect(r.choices?.options.filter(o => o.free).map(o => o.label)).toEqual(c.free ?? [])
    expect(r.choices?.cursor).toBe(0)
    expect(r.choices?.identity).toBeTruthy()
  })

  it.each(CASES.filter(c => c.status))('$name: core\'s own status wins over the screen', (c) => {
    const r = readCoreScreen(screen(c.name), agentOf(c), c.status)
    expect(r.status).toBeNull()
    expect(r.interaction).toBe(c.interaction)
  })

  it.each(menus)('$name: the same choices when core reports the question', (c) => {
    const r = readCoreScreen(screen(c.name), agentOf(c), 'blocked')
    expect(r.interaction).toBe('native')
    expect(r.choices?.options.map(o => o.label)).toEqual(c.options)
  })

  it('reads Claude\'s usage-limit footer as a native wait once core reports the agent idle', () => {
    expect(readCoreScreen(screen('claude-usage-limit'), 'claude', 'idle')).toMatchObject({ status: null, choices: null, interaction: 'native' })
  })
})

describe('enrich + card preview on recorded screens', () => {
  it('keeps an idle Devin at its input without opening the terminal window', async () => {
    const text = screen('devin-idle')
    const screens = createCoreScreens({ call: async () => ({ text }), viewed: () => true })
    const p = { id: 'devin-idle', agent: 'devin', status: 'idle', coreAddress: 'host-a/t8' } as Pane
    await screens.enrich([p])
    const window = createInteractionWindow()
    window.update(p.interaction!, 0)
    expect(window.update(p.interaction!, 500)).toBe(false)
    expect(p.interaction).toBe('input')
    expect(readCoreScreen(text, 'devin', 'unknown').status).toBe('idle')
    expect(readCoreScreen(text, 'codex', 'idle').interaction).toBe('terminal')
    expect(readCoreScreen(text.replace('Context:', 'Status:'), 'devin', 'idle').interaction).toBe('terminal')
  })

  it.each(CASES)('$name', async (c) => {
    const text = screen(c.name)
    const screens = createCoreScreens({ call: async () => ({ text }), viewed: () => true })
    const p = pane(c)
    await screens.enrich([p])
    expect(p.status).toBe(c.status ?? 'unknown')
    expect(p.interaction).toBe(c.interaction)
    expect(p.error).toBe(c.error)
    if (c.options && c.interaction === 'native') expect(p.prompt?.options.map(o => o.label)).toEqual(c.options)
    else expect(p.prompt).toBeUndefined()

    const previews = createCorePreviews({ reply: async () => null, read: async () => text })
    previews.apply([p])
    await settle()
    const shown = { ...p, preview: undefined } as Pane
    previews.apply([shown])
    expect(shown.preview).toBe(c.preview)
  })
})

describe('coreChoose on recorded questions', () => {
  // Every fixed (non-free) option is reached from the cursor with arrow keys, then Enter.
  const rows = menus.flatMap(c => c.options!.map((label, index) => ({ c, label, index })).filter(o => !c.free?.includes(o.label)))
  it.each(rows.map(r => ({ ...r, name: r.c.name })))('$name: option $index ($label)', async ({ c, label, index }) => {
    const text = screen(c.name)
    const p = pane(c, { status: 'blocked' })
    const calls: [string, unknown][] = []
    const identity = readCoreScreen(text, p.agent, 'blocked').choices!.identity
    await coreChoose({
      call: async (m, params) => { calls.push([m, params]); return {} as never },
      pane: id => (id === p.id ? p : undefined), panes: () => [p], refresh: () => {},
      read: async () => text, sleep: async () => {},
    }, { pane_id: p.id, index, label, identity })
    expect(calls).toEqual([['terminal.keys', { terminal: p.coreAddress, keys: [...Array(index).fill('down'), 'enter'] }]])
  })
})
