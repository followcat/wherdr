import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyScreen, confirmedInput, terminalException } from '../shared/interactiveScreen'
import { parseChoices, parseOmpPrompt } from '../server/utils/choices'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('terminal fallback after native recognition', () => {
  it.each(['claude-ask.txt', 'claude-ask-long.txt', 'claude-ask-multi.txt', 'claude-ask-tabs-1.txt', 'claude-security-guide.txt', 'codex-login.txt', 'codex-model-1.txt', 'omp-ask-tabs.txt'])(
    'preserves the existing native prompt %s', name => {
      const text = fx(name)
      const agent = name.startsWith('omp') ? 'omp' : name.startsWith('codex') ? 'codex' : 'claude'
      const choices = agent === 'omp' ? parseOmpPrompt(text) : parseChoices(text)
      expect(choices).toBeTruthy()
      expect(classifyScreen({ text, agent, choices })).toBe('native')
    },
  )
  it('preserves an already open free-answer field', () => {
    const choices = { question: 'Favourite colour?', cursor: 0, typing: true, options: [{ label: 'Other (type your own)', free: true }] }
    expect(classifyScreen({ text: 'An open answer box', agent: 'omp', choices })).toBe('native')
  })
  it('preserves native menus, waiting screens and settings without requiring choices', () => {
    for (const recognized of [{ menu: {} }, { screen: {} }, { settings: true }]) {
      expect(classifyScreen({ text: 'A native screen', agent: 'claude', ...recognized })).toBe('native')
    }
  })
  it.each(['codex-usage-menu.txt', 'codex-command-center.txt'])('uses the explicit terminal exception %s', name => {
    const text = fx(name)
    expect(terminalException(text)).toBe(true)
    expect(classifyScreen({ text, agent: 'codex', choices: parseChoices(text), screen: {} })).toBe('terminal')
    expect(confirmedInput(text)).toBe(false)
  })
  it.each(['codex-idle.txt', 'claude-idle.txt', 'omp-fresh-nerd.txt', 'omp-idle-footer.txt'])(
    'confirms the real message field in %s', name => expect(confirmedInput(fx(name))).toBe(true),
  )
  it.each(['claude', 'codex', 'omp'])('keeps long %s drafts and wrapped footers at the message field', agent => {
    const draft = Array.from({ length: 30 }, (_, i) => `  draft line ${i}`).join('\n')
    const text = agent === 'claude' ? `────────────────\n❯ draft\n${draft}\n────────────────\n  auto mode`
      : agent === 'codex' ? `› draft\n${draft}\n\n  GPT-6-Sol medium ·\n  ~/demo\n  status wraps\n  on a phone\n  ? for shortcuts`
        : ` π > Opus > demo\n╰─ draft\n${draft}`
    expect(confirmedInput(text)).toBe(true)
    expect(classifyScreen({ text, agent })).toBe('input')
  })
  it.each(['pi', 'gemini', 'kimi', null])('does not infer a menu from an unsupported agent %s', agent => {
    expect(classifyScreen({ text: 'A normal reply without a known input marker', agent })).toBe('unknown')
  })
  it.each(['devin-idle.txt', 'devin-status-plain.txt', 'devin-idle-edits.txt', 'devin-idle-narrow.txt'])(
    'confirms the Devin field in %s whatever its footer says', name => {
      const text = fx(name)
      expect(confirmedInput(text, 'devin')).toBe(true)
      expect(classifyScreen({ text, agent: 'devin', status: 'idle' })).toBe('input')
      // Mid-paint, before the footer is drawn, the field is not confirmed.
      expect(confirmedInput(text.trimEnd().split('\n').slice(0, -1).join('\n'), 'devin')).toBe(false)
    },
  )
  it.each(['devin-fusion-lead.txt', 'devin-fusion-sidekick.txt', 'devin-menu.txt'])('never reads the Devin picker %s as the field', name => {
    expect(confirmedInput(fx(name), 'devin')).toBe(false)
  })
  it('reads an unrecognized opencode screen as a plain terminal like other transcript agents', () => {
    expect(classifyScreen({ text: 'A normal reply without a known input marker', agent: 'opencode' })).toBe('terminal')
  })
  it.each(['devin-fusion-lead.txt', 'devin-fusion-sidekick.txt'])('excludes the Fusion picker %s by its legend, whatever its slider is drawn with', name => {
    // Drawn with ─ instead of ━, the slider would pass for the field's lower rule.
    expect(confirmedInput(fx(name).replaceAll('━', '─'), 'devin')).toBe(false)
  })
  it('never reads normal working output as an interactive fallback', () => {
    expect(classifyScreen({ text: 'Thinking…', agent: 'codex', status: 'working' })).toBe('working')
    expect(classifyScreen({ text: '', agent: 'codex' })).toBe('unknown')
  })
})
