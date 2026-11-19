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
import { clinePreviewText, parseClineApproval } from '../shared/clineScreen'

const screen = (name: string) => readFileSync(new URL(`./fixtures/core-screens/${name}.txt`, import.meta.url), 'utf8')
// The status footer under the field: its meter line, then the workspace and the
// auto-approve line. Provider names in it vary.
const withoutFooter = (text: string) => {
  const lines = text.split('\n')
  const meter = lines.findLastIndex(l => /█{2,}\s*\(\d[\d,]*\)/.test(l))
  return meter > 0 ? lines.slice(0, meter).join('\n') : text
}
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
  /** Literal key each option is answered with (Cline's `[y]` / `[n]`). */
  optionKeys?: string[]
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
  // Antigravity: `>` between rules at rest, "esc to cancel" only while it runs.
  { name: 'agy-idle', status: 'idle', interaction: 'input', preview: 'Added three cases for the date parser; all tests pass.' },
  { name: 'agy-working', status: 'working', interaction: 'working', preview: '⠋ Working… (12s)' },
  {
    name: 'agy-question', status: 'blocked', interaction: 'native', preview: '3. No',
    question: 'Allow Antigravity to run this command?',
    options: ['Yes', 'Always allow', 'No'],
  },
  // Cline: `❯ Ask anything...` between rules, a braille spinner while it runs,
  // and a permission box answered by its own letters.
  { name: 'cline-idle', status: 'idle', interaction: 'input', preview: 'Result: the directory is empty. /home/user/acme-shop contains only the two implicit entries.' },
  { name: 'cline-working', status: 'working', interaction: 'working', preview: '⠏ Thinking... (esc to cancel)' },
  {
    name: 'cline-approval', status: 'blocked', interaction: 'native', preview: '[y] Approve   [n] Deny',
    question: 'Approve tool call?', options: ['Approve', 'Deny'], optionKeys: ['y', 'n'],
  },
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
    expect(r.choices?.options.map(o => o.key)).toEqual(c.options.map((_, i) => c.optionKeys?.[i]))
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

// Cline's footer says "Auto-approve all disabled (Shift+Tab)": that word is not
// an approval request. Only the box (`[y] Approve   [n] Deny` under its
// question) is one.
describe('Cline approvals', () => {
  it('never reads the idle or working footer as an approval', () => {
    for (const name of ['cline-idle', 'cline-working']) {
      expect(parseClineApproval(screen(name)), name).toBeNull()
      expect(readCoreScreen(screen(name), 'cline', 'unknown').choices, name).toBeNull()
    }
    const footer = screen('cline-idle').trimEnd().split('\n').slice(-3).join('\n')
    expect(footer).toContain('Auto-approve all disabled')
    expect(parseClineApproval(footer)).toBeNull()
  })

  it('keeps the box\'s tool and command as the permission detail', () => {
    const choices = parseClineApproval(screen('cline-approval'))
    expect(choices?.question).toBe('Approve tool call?')
    expect(choices?.detail).toMatchObject({ tool: 'run_commands', command: 'ls' })
    expect(choices?.options.map(o => [o.label, o.key])).toEqual([['Approve', 'y'], ['Deny', 'n']])
    expect(choices?.identity).toBeUndefined()
  })

  // hc reports no agent for Cline, so there is no status to tell a panel from a
  // frame still being painted: an unrecognized screen stays 'unknown' (the
  // conversation stays, the Terminal tab is there) rather than becoming a
  // terminal overlay on a guess.
  it('leaves an unrecognized screen unknown instead of a terminal', () => {
    expect(readCoreScreen(withoutFooter(screen('cline-idle')), 'cline', 'unknown'))
      .toMatchObject({ status: null, choices: null, interaction: 'unknown' })
  })

  // The live box replaces the message field and the screen ends with the
  // footer. A box quoted above the field (a reply, a fixture being edited, a
  // pasted capture) is history: no buttons, and never a "blocked" pane.
  it('refuses a box quoted above the message field', () => {
    const lines = screen('cline-idle').split('\n')
    const rule = lines.findIndex(l => /^\s*─{10,}\s*$/.test(l))
    const quoted = [
      ...lines.slice(0, rule), '',
      ' Cline needs permission', '', ' Approve tool call?', '', ' run_commands', '', '   $ ls', '', '  [y] Approve   [n] Deny', '',
      ...lines.slice(rule),
    ].join('\n')
    expect(quoted).toContain('❯ Ask anything')
    expect(parseClineApproval(quoted)).toBeNull()
    const r = readCoreScreen(quoted, 'cline', 'unknown')
    expect(r.choices).toBeNull()
    expect(r.status).toBe('idle')
  })

  // Another provider prints its own name where the capture says ClinePass: the
  // footer is recognised by its meter and its auto-approve line.
  it('reads a box whose footer names another provider', () => {
    const renamed = screen('cline-approval').replace('ClinePass:', 'Demo Provider:')
    expect(parseClineApproval(renamed)).toMatchObject({ question: 'Approve tool call?', detail: { tool: 'run_commands', command: 'ls' } })
    expect(clinePreviewText(renamed).trimEnd().split('\n').at(-1)?.trim()).toBe('[y] Approve   [n] Deny')
    expect(readCoreScreen(renamed, 'cline', 'unknown')).toMatchObject({ status: 'blocked', interaction: 'native' })
  })

  // Anything but blank lines between the options and the footer means the box
  // is not the screen's last element: still history, not a request.
  it('refuses a box followed by other text before the footer', () => {
    const trailing = screen('cline-approval')
      .replace('  [y] Approve   [n] Deny\n', '  [y] Approve   [n] Deny\n\n That was a past box.\n')
    expect(parseClineApproval(trailing)).toBeNull()
    expect(readCoreScreen(trailing, 'cline', 'unknown').choices).toBeNull()
  })
})


// Antigravity reports its own status (idle under these panels). A slash command
// from the conversation (+ menu or typed) that opens a panel or a picker shows
// the interactive terminal over the conversation; Esc there brings the field back.
// The model list is never offered as choices: a tap must not switch the model.
describe('Antigravity slash-command panels', () => {
  const PANELS = ['agy-context', 'agy-usage', 'agy-diff', 'agy-model']

  it.each(PANELS)('%s opens the terminal', (name) => {
    expect(readCoreScreen(screen(name), 'agy', 'idle')).toEqual({ status: null, choices: null, interaction: 'terminal' })
    expect(readCoreScreen(screen(name), 'agy', 'blocked').choices).toBeNull()
  })

  it(`${PANELS[0]}: read as the terminal, Esc back to the field`, async () => {
    const name = PANELS[0]!
    let text = screen(name)
    const screens = createCoreScreens({ call: async () => ({ text }), viewed: () => true })
    const p = { id: name, agent: 'agy', status: 'idle', coreAddress: 'host-a/t2' } as Pane
    await screens.enrich([p])
    expect(p.interaction).toBe('terminal')
    // The overlay itself opens once 'terminal' has held for 500 ms.
    const window = createInteractionWindow()
    expect(window.update(p.interaction!, 0)).toBe(false)
    expect(window.update(p.interaction!, 500)).toBe(true)
    text = screen('agy-idle')
    screens.forget(p.id)
    await screens.enrich([p])
    expect(p.interaction).toBe('input')
  })
})

// Devin reports its own status (idle under this panel). A slash command from
// the conversation (+ menu or typed) that opens a panel shows the interactive
// terminal over the conversation; Esc there brings the field back. Devin's
// /shortcuts replaces the message field with a searchable accordion: its ❭/▸
// markers are not a prompt cursor, so nothing is offered as choices.
describe('Devin slash-command panels', () => {
  const PANELS = ['devin-shortcuts']

  it.each(PANELS)('%s opens the terminal', (name) => {
    expect(readCoreScreen(screen(name), 'devin', 'idle')).toEqual({ status: null, choices: null, interaction: 'terminal' })
    expect(readCoreScreen(screen(name), 'devin', 'blocked').choices).toBeNull()
  })

  it.each(PANELS)('%s: confirmed on its second read, closed by Esc', async (name) => {
    let text = screen(name)
    let t = 0
    const screens = createCoreScreens({ call: async () => ({ text }), viewed: () => true, now: () => t })
    const p = { id: name, agent: 'devin', status: 'idle', coreAddress: 'host-a/t2' } as Pane
    await screens.enrich([p])
    expect(p.interaction).toBe('unknown')
    t += 300
    await screens.enrich([p])
    expect(p.interaction).toBe('terminal')
    text = screen('devin-idle')
    t += 300
    await screens.enrich([p])
    expect(p.interaction).toBe('input')
  })
})

    await screens.enrich([p])
    expect(p.interaction).toBe('input')
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
    // The footer's words vary (mode, hints, width): only a frame still being
    // painted, without its footer, is not the field.
    expect(readCoreScreen(text.replace('Context:', 'Status:'), 'devin', 'idle').interaction).toBe('input')
    expect(readCoreScreen(text.replace(/\n[^\n]*Context:[^\n]*\n?$/, ''), 'devin', 'idle').interaction).toBe('terminal')
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
    // A box that names its letters (Cline's `[y]` / `[n]`) is answered with
    // them; the others move the cursor, then Enter.
    const keys = c.optionKeys ? [c.optionKeys[index]!] : [...Array(index).fill('down'), 'enter']
    expect(calls).toEqual([['terminal.keys', { terminal: p.coreAddress, keys }]])
  })
})
