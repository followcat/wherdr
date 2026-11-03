// Blocking prompts read from Herdr's "detection" screen.
// Fixtures: real screens captured in the test session (claude-ask, claude-idle,
// codex-idle); trust screens rebuilt from their known shape
// (claude-trust, claude-security-guide, codex-trust: the machine already trusts ~).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { completeOmpAsk, inputVisible, panelOpen, keysFor, ompActiveTab, opencodeDecision, parseChoices, parseOmpAsk, parseOmpField, parseOpenCodePermission, pendingOmpAsk, sameQuestion, screenChoices } from '../server/utils/choices'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('parseChoices', () => {
  it('reads a Claude AskUserQuestion question (numbered options, descriptions, separator)', () => {
    const c = parseChoices(fx('claude-ask.txt'))
    expect(c).not.toBeNull()
    expect(c!.question).toBe('Quel fruit préfères-tu ?')
    expect(c!.cursor).toBe(0)
    expect(c!.options.map(o => o.label)).toEqual(['Pomme', 'Poire', 'Banane', 'Type something.', 'Chat about this'])
    expect(c!.options[0]!.hint).toBe('Croquante et acidulée')
    expect(c!.options[3]!.hint).toBeNull()
  })

  it('ignores Claude\'s input field when idle (strict mode, used outside blocking)', () => {
    expect(parseChoices(fx('claude-idle.txt'), { strict: true })).toBeNull()
  })

  it('reads Claude\'s folder trust screen', () => {
    const c = parseChoices(fx('claude-trust.txt'))!
    expect(c.question).toBe('Do you trust the files in this folder?')
    expect(c.options.map(o => o.label)).toEqual(['Yes, proceed', 'No, exit'])
  })

  it('reads an unnumbered list (❯ cursor), but not in strict mode', () => {
    const c = parseChoices(fx('claude-security-guide.txt'))!
    expect(c.question).toBe('Security guide')
    expect(c.options.map(o => o.label)).toEqual(['No, exit', 'Yes, I trust this folder'])
    expect(parseChoices(fx('claude-security-guide.txt'), { strict: true })).toBeNull()
  })

  it('reads Codex\'s trust screen (› cursor) even in strict mode', () => {
    const c = parseChoices(fx('codex-trust.txt'), { strict: true })!
    expect(c.question).toMatch(/^Do you trust the contents of this directory\?/)
    expect(c.options.map(o => o.label)).toEqual(['Yes, continue', 'No, quit'])
    expect(c.cursor).toBe(0)
  })

  it('does not take the "› Ask Codex…" field for a question', () => {
    expect(parseChoices(fx('codex-idle.txt'), { strict: true })).toBeNull()
    expect(parseChoices(fx('codex-idle.txt'))).toBeNull()
  })

  it('ignores the diff panel shown to the right of a permission request', () => {
    const c = parseChoices(fx('claude-permission-diff.txt'), { strict: true })!
    expect(c.question).toBe('Do you want to proceed?')
    expect(c.options.map(o => o.label)).toEqual([
      'Yes',
      'Yes, and don\'t ask again for npm test commands',
      'No, and tell Claude what to do differently (esc)',
    ])
    expect(c.options.every(o => o.hint === null)).toBe(true)
    expect(c.cursor).toBe(0)
  })

  it('cuts at the vertical bar of a neighbouring panel, even right against the options', () => {
    const screen = [
      ' Do you want to proceed? │ 12 + <div v-if="ok">',
      ' ❯ 1. Yes                │ 13 +   label="Name"',
      '   2. No                 │ 14 + />',
      '                         │ 15 + >',
    ].join('\n')
    const c = parseChoices(screen)!
    expect(c.question).toBe('Do you want to proceed?')
    expect(c.options.map(o => o.label)).toEqual(['Yes', 'No'])
  })

  it('keeps the aligned descriptions of a list without a neighbouring panel', () => {
    const c = parseChoices('  Pick a size\n\n❯ 1. Small     Quick\n  2. Large     Slow')!
    expect(c.options.map(o => o.label)).toEqual(['Small     Quick', 'Large     Slow'])
  })

  it('refuses a numbered list with a gap', () => {
    expect(parseChoices('Choix ?\n❯ 1. A\n  3. C')).toBeNull()
  })

  it('trouve le curseur au milieu de la liste', () => {
    const c = parseChoices('Quoi ?\n  1. A\n❯ 2. B\n  3. C')!
    expect(c.cursor).toBe(1)
    expect(keysFor(c, 0)).toEqual(['up', 'enter'])
    expect(keysFor(c, 2)).toEqual(['down', 'enter'])
    expect(keysFor(c, 1)).toEqual(['enter'])
  })
})

describe('keysFor', () => {
  it('descend depuis le curseur puis valide', () => {
    const c = parseChoices(fx('claude-ask.txt'))!
    expect(keysFor(c, 2)).toEqual(['down', 'down', 'enter'])
  })
})

describe('inputVisible', () => {
  it('voit le champ de saisie de Claude et de Codex', () => {
    expect(inputVisible(fx('claude-idle.txt'))).toBe(true)
    expect(inputVisible(fx('codex-idle.txt'))).toBe(true)
  })
  it('does not see it when a panel hides it', () => {
    expect(inputVisible('  Usage\n  ████ 40%\n\n  Esc to close')).toBe(false)
  })
  it('does not mistake a menu cursor for the input field', () => {
    expect(inputVisible(fx('claude-trust.txt'))).toBe(false)
    expect(inputVisible(fx('claude-model-1.txt'))).toBe(false)
    expect(inputVisible(' Manage MCP servers\n\n ❯ 1. demo-server · authenticate\n   2. other-server\n\n Esc to cancel')).toBe(false)
  })


  // OpenCode 2.x: its composer is a box — "┃" input lines ending on a "╹▀"
  // bottom rule, just above the status footer.
  it('sees OpenCode’s composer field (┃ lines ending on its ╹▀ rule)', () => {
    const idle = ` some output

┃ Ask anything…
┃
╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 opencode 2.0 · gpt-5 · ~/repo
`
    expect(inputVisible(idle)).toBe(true)
  })
  it('does not see OpenCode’s field during a permission dialog', () => {
    // The dialog keeps the composer box on screen — its markers must fail it.
    const dialog = `△ Permission required

❯ Allow once   Always   Reject

┃ run tests
┃
╹▀▀▀▀▀▀▀▀▀▀▀▀▀
↑↓ select · enter confirm · esc dismiss
`
    expect(inputVisible(dialog)).toBe(false)
    // No composer at all: no ┃ above the rule.
    const scrolled = `output
╹▀▀▀▀▀▀▀▀▀▀▀▀▀
footer
`
    expect(inputVisible(scrolled)).toBe(false)
  })
  it('keeps the OpenCode field when dialog words appear in ordinary text', () => {
    // A lone "enter confirm" is prose, not the dialog footer — the markers
    // need the same conjunction herdr uses (dismiss + action + nav).
    const idle = ` some output\nThe shortcut is "enter confirm".\n┃ Ask anything…\n┃\n╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n opencode 2.0 · gpt-5\n`
    expect(inputVisible(idle)).toBe(true)
    expect(inputVisible(idle, 'opencode')).toBe(true)
  })
  it('scopes field recognition to the pane’s own agent composer', () => {
    // A "›" or "❯" glyph inside OpenCode/Devin output is not an input field.
    const ocOutput = `› some transcript line\n┃ Ask anything…\n┃\n╹▀▀▀▀▀▀▀▀▀▀▀▀▀\n opencode\n`
    expect(inputVisible(ocOutput, 'opencode')).toBe(true)
    const ocDialog = `△ Permission required\n› Allow once\n┃ run tests\n┃\n╹▀▀▀▀▀▀▀▀▀▀▀▀▀\n↑↓ select · enter confirm · esc dismiss\n`
    expect(inputVisible(ocDialog, 'opencode')).toBe(false)
    const devinOut = `› claude-looking output\n❭ Ask Devin anything\n───\nSWE-2 Max\n`
    expect(inputVisible(devinOut, 'opencode')).toBe(false)
    // Without an agent hint the recognizers stay backward compatible.
    expect(inputVisible(ocOutput)).toBe(true)
  })
})

describe('panelOpen', () => {
  it('closes a full-screen panel but leaves a menu the user may be using', () => {
    expect(panelOpen('  Usage\n  ████ 40%\n\n  Esc to close', 'claude')).toBe(true)
    expect(panelOpen(fx('claude-trust.txt'), 'claude')).toBe(false)
    expect(panelOpen(fx('claude-idle.txt'), 'claude')).toBe(false)
  })

  it('never sees a panel on omp: Escape there opens its branch selector', () => {
    expect(panelOpen(fx('omp-idle-footer.txt'), 'omp')).toBe(false)
  })
})

describe('parseOmpAsk', () => {
  // Real screens of omp's ask tool (two questions: single choice, checkboxes, then Submit).
  it('reads a single-choice question, without the tabs, "Other" as a free answer', () => {
    const c = parseOmpAsk(fx('omp-ask-single.txt'))!
    expect(c.question).toBe('Favourite colour?')
    expect(c.options).toEqual([{ label: 'Red', hint: 'warm' }, { label: 'Green', hint: 'calm' }, { label: 'Blue', hint: 'cool' }, { label: 'Other (type your own)', hint: null, free: true }])
    expect(c.cursor).toBe(0)
    expect(c.multi).toBeUndefined()
    expect(c.typing).toBeUndefined()
    expect(keysFor(c, 2)).toEqual(['down', 'down', 'enter'])
  })

  it('reads checkboxes: checked state, Space to check without confirming', () => {
    const c = parseOmpAsk(fx('omp-ask-multi.txt'))!
    expect(c.question).toBe('Pick sizes')
    expect(c.multi).toBe(true)
    expect(c.options.map(o => [o.label, o.checked])).toEqual([['Small', true], ['Medium', false], ['Large', true], ['Other (type your own)', false]])
    expect(c.cursor).toBe(2)
    expect(keysFor(c, 1)).toEqual(['up', 'space'])
  })

  it('last step: Submit, with the answers', () => {
    const c = parseOmpAsk(fx('omp-ask-review.txt'))!
    expect(c.question).toBe('Review answers')
    expect(c.options).toEqual([{ label: 'Submit', hint: 'color: Red · size: Small, Large' }])
    expect(keysFor(c, 0)).toEqual(['enter'])
  })

  it('nothing without an Ask box; screenChoices picks the reader per agent', () => {
    expect(parseOmpAsk(fx('claude-ask.txt'))).toBeNull()
    expect(screenChoices(fx('omp-ask-single.txt'), 'claude')).toBeNull()
    expect(screenChoices(fx('omp-ask-single.txt'), 'omp')!.options).toHaveLength(4)
  })

  // Real screens: "Other" already answered, then its field reopened (prefilled).
  it('"Other" already answered: its text as the description', () => {
    const box = [
      '╭─ Ask ──────────────────────────────────────╮',
      '│  color    size    Submit                   │',
      '│ Favourite colour?                          │',
      '├────────────────────────────────────────────┤',
      '│   ○ Red                                    │',
      '│ ❯ ◉ Other (type your own)                  │',
      '│       Teal with a hint of grey, quite a l… │',
      '├────────────────────────────────────────────┤',
      '│ ⏎ select · n note · ↑/↓ move · ⎋ cancel    │',
      '╰────────────────────────────────────────────╯',
    ].join('\n')
    expect(parseOmpAsk(box)!.options[1]).toEqual({ label: 'Other (type your own)', hint: 'Teal with a hint of grey, quite a l…', free: true })
  })

  const field = (rows: string[], legend = ['│ ⏎ or ⌃Q submit  ⎋ cancel  ⌃G external editor │']) => [
    // "ask" call shown in the conversation, higher up: not the active box.
    '╭─── Ask 2 questions ─────────────────────────╮',
    '├─── [color] · options:2 ─────────────────────┤',
    '│  Favourite colour?                          │',
    '│  ○ Red                                      │',
    '╰─────────────────────────────────────────────╯',
    '',
    '  ⎋ Asking colour and sizes',
    '',
    '╭─ Custom answer: Favourite colour? ─────────╮',
    '│                                             │',
    ...rows,
    '│                                             │',
    ...legend,
    '│                                             │',
    '╰─────────────────────────────────────────────╯',
    ' ◕ Opus 5.5 👁 · 🗑 /tmp',
  ].join('\n')

  it('free-answer field open: its question, its text, its rows', () => {
    const text = field(['│ > Teal                                      │', '│   with a hint of grey, wrapped onto a       │', '│   second row                                │'])
    expect(parseOmpField(text)).toEqual({ question: 'Favourite colour?', value: 'Teal\nwith a hint of grey, wrapped onto a\nsecond row', rows: 3 })
    expect(parseOmpAsk(text)).toEqual({
      question: 'Favourite colour?', cursor: 0, typing: true,
      options: [{ label: 'Other (type your own)', hint: 'Teal with a hint of grey, wrapped onto a second row', free: true }],
    })
  })

  it('empty field; an Ask box shown below an old field wins', () => {
    const empty = field(['│ >                                           │'])
    expect(parseOmpField(empty)).toEqual({ question: 'Favourite colour?', value: '', rows: 1 })
    expect(parseOmpAsk(empty)!.options[0]!.hint).toBeNull()
    const after = `${empty}\n${fx('omp-ask-single.txt')}`
    expect(parseOmpField(after)).toBeNull()
    expect(parseOmpAsk(after)!.typing).toBeUndefined()
  })

  it('narrow pane: the legend on two rows; blank lines of the text kept', () => {
    const narrow = ['│ ⏎ or ⌃Q submit  ⎋ cancel │', '│ ⌃G external editor     │']
    expect(parseOmpField(field(['│ >                       │'], narrow))).toMatchObject({ value: '', rows: 1 })
    expect(parseOmpField(field(['│ > Teal                  │', '│                         │', '│                         │'], narrow))).toMatchObject({ value: 'Teal\n\n', rows: 3 })
  })

  it('sameQuestion: cut on screen or completed from the transcript, but not another one', () => {
    const full = 'Plan for titles. Approve?\n\n1. Service: trims the title.'
    expect(sameQuestion('Plan for titles. Approve?1. Service: tr…', full)).toBe(true)
    expect(sameQuestion(full, 'Plan for titles. Approve?')).toBe(true)
    expect(sameQuestion('Pick sizes', 'Favourite colour?')).toBe(false)
    expect(sameQuestion(null, 'Favourite colour?')).toBe(false)
    expect(sameQuestion(null, null)).toBe(true)
  })

  // Real screens (three questions): detection text, and the same in ANSI.
  it('tabs: questions then Submit; the Review step is on Submit', () => {
    const q = parseOmpAsk(fx('omp-ask-tabs.txt'))!
    expect(q.question).toBe('Favourite colour?')
    expect(q.tabs).toEqual(['color', 'size', 'Pet', 'Submit'])
    expect(q.tab).toBeUndefined()
    const review = parseOmpAsk(fx('omp-ask-tabs-review.txt'))!
    expect(review.question).toBe('Review answers')
    expect([review.tabs, review.tab]).toEqual([['color', 'size', 'Pet', 'Submit'], 3])
    expect(parseOmpAsk(fx('omp-ask-tabs-review.txt').replace(/│ {2}color {4}size {4}Pet {4}Submit/, '│  color    size   \n│  Pet    Submit')))
      .toMatchObject({ question: 'Review answers', tabs: ['color', 'size', 'Pet', 'Submit'] })
  })

  it('tab shown: the one on a coloured background in the ANSI screen', () => {
    const tabs = ['color', 'size', 'Pet', 'Submit']
    expect(ompActiveTab(fx('omp-ask-tabs.ansi'), tabs)).toBe(1)
    // Without ANSI, or another bar: not found.
    expect(ompActiveTab(fx('omp-ask-tabs.txt'), tabs)).toBeNull()
    expect(ompActiveTab(fx('omp-ask-tabs.ansi'), ['color', 'size', 'Submit'])).toBeNull()
    // Box on a coloured background (theme): only the tab on another background counts; reverse video too.
    const panel = (cell: (label: string, on: boolean) => string) => ['\x1b[48;5;236m╭─ Ask ──╮', `\x1b[48;5;236m│ ${['a', 'b', 'Submit'].map((l, i) => cell(l, i === 2)).join('  ')} │\x1b[0m`].join('\n')
    expect(ompActiveTab(panel((l, on) => (on ? `\x1b[48;2;0;130;179m ${l} \x1b[48;5;236m` : ` ${l} `)), ['a', 'b', 'Submit'])).toBe(2)
    expect(ompActiveTab(panel((l, on) => (on ? `\x1b[7m ${l} \x1b[27m` : ` ${l} `)), ['a', 'b', 'Submit'])).toBe(2)
  })
})

describe('parseOmpAsk, jeu de symboles ascii', () => {
  it('reads the same box drawn in ascii (> cursor, (o) / [x], + - | borders)', () => {
    const box = [
      '+- Ask -------------------------+',
      '| a    b    Submit              |',
      '| Pick sizes                    |',
      '+-------------------------------+',
      '|   [x] Small                   |',
      '| > [ ] Medium                  |',
      '|   [ ] Other (type your own)   |',
      '+-------------------------------+',
      '| space toggle · enter next     |',
      '+-------------------------------+',
    ].join('\n')
    const c = parseOmpAsk(box)!
    expect(c).toEqual({ question: 'Pick sizes', cursor: 1, multi: true, tabs: ['a', 'b', 'Submit'], options: [
      { label: 'Small', hint: null, checked: true }, { label: 'Medium', hint: null, checked: false },
      { label: 'Other (type your own)', hint: null, checked: false, free: true },
    ] })
  })
})

describe('completeOmpAsk', () => {
  // The box folds a long question ("…") and joins its lines; the
  // transcript has the full text of the "ask" call still unanswered.
  const question = 'Plan for titles. Approve?\n\n1. Service: trims the title and writes a system_event.\n2. HTTP: PATCH /title.'
  const call = (id: string, q: string) => JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'ask', arguments: { questions: [
    { id: 'other', question: 'Email subject?', options: [{ label: 'Keep' }] },
    { id: 'plan', question: q, options: [{ label: 'Approve' }, { label: 'Revise', description: 'Tell me what to change,\nline by line.' }] },
  ] } }] } })
  const box = [
    '╭─ Ask ─────────────────────────────────────╮',
    '│  other    plan    Submit                  │',
    '│ Plan for titles. Approve?1. Service: trims │',
    '│ the title and writes a syst…              │',
    '├───────────────────────────────────────────┤',
    '│ ❯ ○ Approve (Recommended)                 │',
    '│   ○ Revise                                │',
    '│       Tell me what to change,             │',
    '│   ○ Other (type your own)                 │',
    '├───────────────────────────────────────────┤',
    '│ ⏎ select · ↑/↓ move · ⎋ cancel            │',
    '╰───────────────────────────────────────────╯',
  ].join('\n')

  it('takes the full question and descriptions from the pending call', () => {
    const c = completeOmpAsk(parseOmpAsk(box)!, pendingOmpAsk([call('old', 'Stale?'), call('t1', question)]))
    expect(c.question).toBe(question)
    expect(c.options).toEqual([{ label: 'Approve (Recommended)', hint: null }, { label: 'Revise', hint: 'Tell me what to change,\nline by line.' }, { label: 'Other (type your own)', hint: null, free: true }])
    expect(c.cursor).toBe(0)
  })

  it('keeps the screen if the call already has its answer or carries another question', () => {
    const shown = parseOmpAsk(box)!
    const answered = JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 't1', toolName: 'ask' } })
    expect(pendingOmpAsk([call('t1', question), answered])).toEqual([])
    expect(completeOmpAsk(shown, pendingOmpAsk([call('t2', 'Something else entirely?')]))).toEqual(shown)
  })
})

describe('parseOpenCodePermission (screenChoices, opencode)', () => {
  // Live captures: OpenCode 2.2.5 permission dialog (100 and 60 columns).
  const cap = (name: string) => readFileSync(new URL(`./captures/${name}`, import.meta.url), 'utf8')
  const shell = cap('opencode-permission-shell.txt')
  const edit = cap('opencode-permission-edit.txt')
  const narrow = cap('opencode-permission-narrow.txt')

  it('reads the shell request, its command and the three decisions', () => {
    const c = parseOpenCodePermission(shell)!
    expect(c.options.map(o => o.label)).toEqual(['Allow once', 'Always allow', 'Reject'])
    expect(c.question).toBe('Allow OpenCode to run: echo hello?')
    expect(c.detail).toMatchObject({ tool: 'Shell command', command: 'echo hello' })
    expect(c.permission).toEqual({ action: 'bash', resources: ['echo hello'] })
    expect(c.horizontal).toBe(true)
    // The cursor is colour-only: without an ANSI read it is unknown, not 0.
    expect(c.cursor).toBe(-1)
  })

  it('reads a file edit and keeps its resource for the API match', () => {
    const c = parseOpenCodePermission(edit)!
    expect(c.question).toBe('Allow OpenCode to edit: notes.txt?')
    expect(c.detail).toMatchObject({ tool: 'Edit notes.txt', file: 'notes.txt', description: 'No diff provided' })
    expect(c.permission).toEqual({ action: 'edit', resources: ['notes.txt'] })
  })

  it('finds options on the row above a separate legend (narrow pane)', () => {
    expect(parseOpenCodePermission(narrow)!.options.map(o => o.label)).toEqual(['Allow once', 'Always allow', 'Reject'])
  })

  it('reads the colour-only cursor from ANSI, and only when exactly one is lit', () => {
    const row = '  ┃  \x1b[48;2;30;30;30m   Allow once   \x1b[48;2;250;178;131m Always allow \x1b[48;2;30;30;30m  Reject   \x1b[0m'
    expect(parseOpenCodePermission(shell, row)!.cursor).toBe(1)
    const none = '\x1b[48;2;30;30;30m   Allow once   Always allow   Reject   \x1b[0m'
    expect(parseOpenCodePermission(shell, none)!.cursor).toBe(-1)
  })

  it('maps labels to the permission API decision and never invents one', () => {
    expect(opencodeDecision('Allow once')).toBe('once')
    expect(opencodeDecision('Always allow')).toBe('always')
    expect(opencodeDecision('Reject')).toBe('reject')
    expect(opencodeDecision('Allow')).toBeNull()
  })

  it('is a native prompt, not an input field or a generic choice list', () => {
    expect(screenChoices(shell, 'opencode')!.options).toHaveLength(3)
    expect(inputVisible(shell, 'opencode')).toBe(false)
    // An OpenCode form/question is not this shape: keep it in the terminal.
    const form = `
  ┃  Choose a flavour
  ┃  Which flavour?  Note  Submit
  ┃  1. [ ] Vanilla
  ┃  2. [ ] Mint
  ┃  ⇆ tab  ↑↓ select  enter toggle  esc dismiss
`
    expect(parseOpenCodePermission(form)).toBeNull()
    expect(screenChoices(form, 'opencode')).toBeNull()
  })

  it('leaves an uncaptured permission action to the terminal', () => {
    const web = shell.replace('# Shell command', '# Web fetch').replace('- echo hello', '- https://example.com')
    expect(parseOpenCodePermission(web)).toBeNull()
    expect(screenChoices(web, 'opencode')).toBeNull()
  })
})
