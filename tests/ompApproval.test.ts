// omp's tool approval dialog (select box "Allow tool: …"): read as a question
// with buttons, and messages sent meanwhile held instead of typed into it.
// Fixtures: real omp 18.4 screens captured in a throwaway session
// (--approval-mode always-ask): bash and eval approvals, an eval whose long
// code scrolls the title off the screen, the idle input field.
// omp-approve-1814-*: real omp 18.14.0 screens (120 columns, a stub model
// calling the tool; the project path replaced by ~/demo): the dialog in the
// composer's place, with a summarized detail row. omp-approve-inline.txt: the
// same dialog without its frame, reconstructed from a user report.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inputVisible, keysFor, parseOmpPrompt, promptIdentity, screenChoices } from '../server/utils/choices'
import { pendingOmpTool } from '../server/utils/promptDetail'
import { shouldHold } from '../server/utils/queued'
import { viaPrompt } from '../shared/sendRoute'
import type { Choices } from '../shared/types'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('omp approval dialog on screen', () => {
  it('reads the tool, its input and the Approve / Deny options', () => {
    expect(screenChoices(fx('omp-approve-bash.txt'), 'omp')).toEqual({
      identity: expect.any(String),
      question: 'Allow tool: bash',
      cursor: 0,
      options: [{ label: 'Approve', hint: null }, { label: 'Deny', hint: null }],
      detail: { tool: 'bash', command: 'Command: echo hello > out.txt' },
    })
    const evalc = screenChoices(fx('omp-approve-eval.txt'), 'omp')!
    expect(evalc.question).toBe('Allow tool: eval')
    expect(evalc.detail).toEqual({ tool: 'eval', command: 'Language: python\nCode:\nprint(6*7)' })
  })
  it('follows the cursor, and answers with arrows then Enter', () => {
    const moved = fx('omp-approve-bash.txt').replace('│  ❯ Approve', '│    Approve').replace('│    Deny ', '│  ❯ Deny ')
    const c = parseOmpPrompt(moved)!
    expect(c.cursor).toBe(1)
    expect(keysFor(c, 0)).toEqual(['up', 'enter'])
    expect(keysFor(parseOmpPrompt(fx('omp-approve-bash.txt'))!, 1)).toEqual(['down', 'enter'])
  })
  it('the legend of the ascii symbol preset ("Up/Down navigate  Enter select  Esc cancel")', () => {
    const ascii = fx('omp-approve-bash.txt').replace('↑/↓ navigate  ⏎ select  ⎋ cancel', 'Up/Down navigate  Enter select  Esc cancel').replace('│  ❯ Approve', '│  > Approve')
    expect(parseOmpPrompt(ascii)).toMatchObject({ cursor: 0, options: [{ label: 'Approve' }, { label: 'Deny' }] })
  })
  it('long input: title scrolled off, still an approval with the visible input', () => {
    const c = parseOmpPrompt(fx('omp-approve-long.txt'))!
    expect(c.question).toBeNull()
    expect(c.options.map(o => o.label)).toEqual(['Approve', 'Deny'])
    expect(c.detail!.tool).toBe('tool')
    expect(c.detail!.command).toMatch(/^print\(\d+\)\n[\s\S]*print\(60\)$/)
  })
  it('a dialog answered and gone is not read again (idle screen, Ask box)', () => {
    expect(parseOmpPrompt(fx('omp-idle-powerline.txt'))).toBeNull()
    expect(parseOmpPrompt(fx('omp-idle-footer.txt'))).toBeNull()
    expect(parseOmpPrompt(fx('omp-ask-single.txt'))!.question).toBe('Favourite colour?')
  })
})

describe('omp 18.14 approval prompt (in the composer\'s place)', () => {
  const labels = (c: Choices | null) => c?.options.map(o => o.label)
  it('reads the tool, its summarized input and every choice, for each tool', () => {
    expect(screenChoices(fx('omp-approve-1814-eval.txt'), 'omp')).toEqual({
      identity: expect.any(String),
      question: 'Allow tool: eval',
      cursor: 0,
      options: [{ label: 'Approve', hint: null }, { label: 'Approve eval for this session', hint: null }, { label: 'Deny', hint: null }],
      detail: { tool: 'eval', command: 'Language: python · Code: print(6*7)' },
    })
    expect(parseOmpPrompt(fx('omp-approve-1814-eval-long.txt'))!.detail).toEqual({ tool: 'eval', command: 'Language: python · Code: import os …' })
    expect(parseOmpPrompt(fx('omp-approve-1814-bash.txt'))).toMatchObject({ question: 'Allow tool: bash', cursor: 1, detail: { tool: 'bash', command: 'Command: echo hello > out.txt' } })
    expect(parseOmpPrompt(fx('omp-approve-1814-edit.txt'))).toMatchObject({ question: 'Allow tool: edit', cursor: 0, detail: { tool: 'edit', command: 'File: notes.txt' } })
    expect(labels(parseOmpPrompt(fx('omp-approve-1814-edit.txt')))).toEqual(['Approve', 'Approve edit for this session', 'Deny'])
  })
  it('symbol presets and a narrow pane (footer cut)', () => {
    expect(parseOmpPrompt(fx('omp-approve-1814-ascii.txt'))).toMatchObject({ question: 'Allow tool: bash', cursor: 0, detail: { command: 'Command: ls -la' } })
    expect(parseOmpPrompt(fx('omp-approve-1814-nerd-write.txt'))).toMatchObject({ question: 'Allow tool: write', cursor: 0, detail: { tool: 'write', command: 'Path: notes.txt · Content: line one …' } })
    expect(parseOmpPrompt(fx('omp-approve-1814-narrow.txt'))).toMatchObject({ question: 'Allow tool: bash', cursor: 2 })
  })
  it('Ctrl+O details: every row on show, without the scrollbar column', () => {
    const c = parseOmpPrompt(fx('omp-approve-1814-eval-details.txt'))!
    expect(c.detail!.command).toBe('Language: python\nCode:\nimport os\nprint(1)\nprint(2)\nprint(3)\nprint(4)\nprint(5)')
    expect(labels(c)).toEqual(['Approve', 'Approve eval for this session', 'Deny'])
  })
  it('grants: the choices start at the "Remember" toggle, the folder listing stays in the details', () => {
    const c = parseOmpPrompt(fx('omp-approve-1814-write-grants.txt'))!
    expect(labels(c)).toEqual(['☐ Remember across sessions', 'Approve Directory: ~/demo', 'Approve File', 'Approve Once', 'Deny'])
    expect(c.cursor).toBe(3)
    expect(c.detail!.command).toMatch(/^Reason: target not yet approved\n[\s\S]*\n {2}- \.git\/\n {2}- notes\.txt$/)
  })
  it('answers with arrows then Enter, from the cursor shown', () => {
    const bash = parseOmpPrompt(fx('omp-approve-1814-bash.txt'))!
    expect(keysFor(bash, 0)).toEqual(['up', 'enter'])
    expect(keysFor(bash, 2)).toEqual(['down', 'enter'])
    const evalc = parseOmpPrompt(fx('omp-approve-1814-eval.txt'))!
    expect(keysFor(evalc, 0)).toEqual(['enter'])
    expect(keysFor(evalc, 1)).toEqual(['down', 'enter'])
  })
  it('a draft in the composer: only "Deny and send message" (the arrows would edit the draft)', () => {
    const c = parseOmpPrompt(fx('omp-approve-1814-draft.txt'))!
    expect(c).toMatchObject({ question: 'Allow tool: eval', cursor: 0, options: [{ label: 'Deny and send message' }] })
    expect(keysFor(c, 0)).toEqual(['enter'])
  })
  it('a countdown in the title neither shows nor changes the question', () => {
    const text = fx('omp-approve-1814-eval.txt')
    const timed = text.replace('╭─ Allow tool: eval ──────', '╭─ Allow tool: eval (12s) ')
    expect(timed).not.toBe(text)
    expect(parseOmpPrompt(timed)!.question).toBe('Allow tool: eval')
    expect(promptIdentity(timed, 'omp')).toBe(promptIdentity(text, 'omp'))
  })
  it('without the frame: title, details, choices and footer at one indent', () => {
    const text = fx('omp-approve-inline.txt')
    expect(screenChoices(text, 'omp')).toEqual({
      identity: expect.any(String),
      question: 'Allow tool: eval',
      cursor: 0,
      options: [{ label: 'Approve', hint: null }, { label: 'Deny', hint: null }],
      detail: { tool: 'eval', command: 'Language: python · Code: import os …' },
    })
    for (const cursor of ['❯', '>', '']) expect(parseOmpPrompt(text.replace('› Approve', `${cursor} Approve`))!.cursor).toBe(0)
    const moved = parseOmpPrompt(text.replace('   › Approve', '     Approve').replace('     Deny', '   › Deny'))!
    expect(moved.cursor).toBe(1)
    expect(keysFor(moved, 0)).toEqual(['up', 'enter'])
    const unicode = text.replace('↵ select · ^↵/^Q approve · ⌫ deny · ^O', '⏎ select · Ctrl+⏎/Ctrl+Q approve · ⎋ deny · Ctrl+O')
    expect(parseOmpPrompt(unicode)!.question).toBe('Allow tool: eval')
    expect(inputVisible(text)).toBe(false)
  })
  it('gone once omp moves on, and the composer is seen again', () => {
    expect(parseOmpPrompt(fx('omp-approve-1814-answered.txt'))).toBeNull()
    expect(inputVisible(fx('omp-approve-1814-answered.txt'))).toBe(true)
    for (const f of ['eval', 'bash', 'draft', 'write-grants', 'narrow']) expect(inputVisible(fx(`omp-approve-1814-${f}.txt`))).toBe(false)
  })
  it('never reads the dialog from transcript text', () => {
    const idle = fx('omp-approve-1814-answered.txt').split('\n')
    const at = idle.findIndex(l => l.startsWith(' Done.'))
    const quote = (rows: string[]) => [...idle.slice(0, at), ...rows, ...idle.slice(at)].join('\n')
    // A reply quoting the prompt, above the idle composer: no footer.
    expect(parseOmpPrompt(quote([' Allow tool: eval', ' > Approve', '   Deny']))).toBeNull()
    // Quoting it with its footer, then more of the conversation below.
    const dialog = [' Allow tool: eval', ' Language: python', ' > Approve', '   Deny', ' ↑/↓ choose · ⏎ select · Ctrl+⏎/Ctrl+Q approve · ⎋ deny']
    expect(parseOmpPrompt(quote([...dialog, ' and then', ' some', ' more', ' lines', ' of', ' the', ' reply']))).toBeNull()
    // Unframed, without the "Allow tool:" title.
    expect(parseOmpPrompt(fx('omp-approve-inline.txt').replace('   Allow tool: eval', '   Something else'))).toBeNull()
    // Framed, but no rule above the footer.
    expect(parseOmpPrompt(fx('omp-approve-1814-eval.txt').replace(/├─+┤\n/, ''))).toBeNull()
    // No Deny row: not an approval.
    expect(parseOmpPrompt(fx('omp-approve-1814-eval.txt').replace('│   Deny  ', '│   Later '))).toBeNull()
  })
  it('the ask box keeps its layout in 18.14', () => {
    expect(parseOmpPrompt(fx('omp-ask-1814-single.txt'))).toEqual({
      question: 'Favourite colour?',
      cursor: 0,
      options: [{ label: 'Red', hint: 'warm' }, { label: 'Green', hint: 'calm' }, { label: 'Blue', hint: 'cool' }, { label: 'Other (type your own)', hint: null, free: true }],
    })
  })
})

describe('omp input field', () => {
  it('is seen when idle (both status line layouts), even with a draft', () => {
    expect(inputVisible(fx('omp-idle-powerline.txt'))).toBe(true)
    expect(inputVisible(fx('omp-idle-powerline.txt').replace(/╰─$/, '╰─ draft text'))).toBe(true)
    expect(inputVisible(fx('omp-idle-footer.txt'))).toBe(true)
  })
  it('is hidden by the approval dialog', () => {
    expect(inputVisible(fx('omp-approve-bash.txt'))).toBe(false)
    expect(inputVisible(fx('omp-approve-long.txt'))).toBe(false)
  })
})

describe('messages sent to omp during the dialog', () => {
  const approval = parseOmpPrompt(fx('omp-approve-bash.txt'))!
  it('go through the held prompt route, never typed + Enter into the dialog', () => {
    expect(viaPrompt({ agent: 'omp', status: 'blocked', prompt: approval })).toBe(true)
    expect(viaPrompt({ agent: 'omp', status: 'blocked', prompt: null })).toBe(true)
  })
  it('omp free-answer field still takes the typed answer', () => {
    const typing: Choices = { question: 'Favourite colour?', cursor: 0, options: [{ label: 'Other (type your own)', hint: null, free: true }], typing: true }
    expect(viaPrompt({ agent: 'omp', status: 'blocked', prompt: typing })).toBe(false)
  })
  it('Claude / Codex questions keep their typed answer', () => {
    expect(viaPrompt({ agent: 'claude', status: 'blocked', prompt: approval })).toBe(false)
    expect(viaPrompt({ agent: 'codex', status: 'blocked', prompt: null })).toBe(true)
    expect(viaPrompt({ agent: 'omp', status: 'idle', prompt: null })).toBe(true)
  })
  it('are held by the server while the input field is hidden', () => {
    expect(shouldHold('omp', 'idle', false, false)).toBe(true)
    expect(shouldHold('omp', 'idle', true, false)).toBe(false)
    expect(shouldHold('omp', 'blocked', true, true)).toBe(true)
  })
})

describe('pendingOmpTool', () => {
  const j = (o: unknown) => JSON.stringify(o)
  const assistant = (...calls: [string, string, unknown][]) => j({ type: 'message', message: { role: 'assistant', content: calls.map(([id, name, args]) => ({ type: 'toolCall', id, name, arguments: args, intent: `run ${name}` })) } })
  const start = (id: string, name: string) => j({ type: 'custom', customType: 'tool_execution_start', data: { toolCallId: id, toolName: name } })
  const result = (id: string) => j({ type: 'message', message: { role: 'toolResult', toolCallId: id } })

  it('full input of the started call with no result yet', () => {
    const code = Array.from({ length: 60 }, (_, i) => `print(${i + 1})`).join('\n')
    expect(pendingOmpTool([assistant(['a', 'eval', { language: 'py', code }]), start('a', 'eval')])).toEqual({ tool: 'eval', description: 'run eval', command: code })
  })
  it('skips answered calls, and picks the one named on screen among parallel calls', () => {
    const lines = [assistant(['a', 'bash', { i: 'x', command: 'ls' }], ['b', 'mcp_demo_search', { query: 'q' }]), start('a', 'bash'), start('b', 'mcp_demo_search')]
    expect(pendingOmpTool(lines, 'bash')).toEqual({ tool: 'bash', description: 'run bash', command: 'ls' })
    expect(pendingOmpTool(lines)!.command).toBe('{\n  "query": "q"\n}')
    expect(pendingOmpTool([...lines, result('a'), result('b')])).toBeNull()
  })
})
