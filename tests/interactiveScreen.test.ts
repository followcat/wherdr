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
  it.each(['codex-idle.txt', 'claude-idle.txt', 'omp-fresh-nerd.txt', 'omp-idle-footer.txt', 'devin-idle.txt'])(
    'confirms the real message field in %s', name => expect(confirmedInput(fx(name))).toBe(true),
  )
  it('classifies an idle Devin screen as its input field, not the terminal fallback', () => {
    const text = fx('devin-idle.txt')
    expect(classifyScreen({ text, agent: 'devin' })).toBe('input')
    // An echoed user line shares the ❭ prefix; only the boxed prompt counts.
    expect(text.indexOf('❭ show me the docs')).toBeGreaterThanOrEqual(0)
  })
  it.each(['claude', 'codex', 'omp'])('keeps long %s drafts and wrapped footers at the message field', agent => {
    const draft = Array.from({ length: 30 }, (_, i) => `  draft line ${i}`).join('\n')
    const text = agent === 'claude' ? `────────────────\n❯ draft\n${draft}\n────────────────\n  auto mode`
      : agent === 'codex' ? `› draft\n${draft}\n\n  GPT-6-Sol medium ·\n  ~/demo\n  status wraps\n  on a phone\n  ? for shortcuts`
        : ` π > Opus > demo\n╰─ draft\n${draft}`
    expect(confirmedInput(text)).toBe(true)
    expect(classifyScreen({ text, agent })).toBe('input')
  })
  it.each(['pi', 'gemini', 'opencode', 'kimi', null])('does not infer a menu from an unsupported agent %s', agent => {
    expect(classifyScreen({ text: 'A normal reply without a known input marker', agent })).toBe('unknown')
  })
  it('never reads normal working output as an interactive fallback', () => {
    expect(classifyScreen({ text: 'Thinking…', agent: 'codex', status: 'working' })).toBe('working')
    expect(classifyScreen({ text: '', agent: 'codex' })).toBe('unknown')
  })
})
