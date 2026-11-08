import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ompPreviewText, parseOmpContext, parseOmpStatus } from '../shared/ompStatus'
import { lastLine } from '../server/utils/corePreview'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('parseOmpStatus', () => {
  it('reads omp 18\'s status line above the box bottom, gauge kept as ▶…◀, in every symbol preset', () => {
    expect(parseOmpStatus(fx('omp-approve-1814-bash.txt'))).toEqual({ line: '⠸ 4s > ⬢ Fake One > 🗑 ~/demo > ⑂ main ?1', meters: expect.stringMatching(/^▶─+6%─+╎───┃─────128K─◀$/) })
    expect(parseOmpContext(parseOmpStatus(fx('omp-idle-powerline.txt'))?.meters)).toEqual({ pct: 1, total: 1_000_000, estimated: 10_000 })
    expect(parseOmpContext(parseOmpStatus(fx('omp-fresh-nerd.txt'))?.meters)).toEqual({ pct: 1, total: 1_000_000, estimated: 10_000 })
    expect(parseOmpContext(parseOmpStatus(fx('omp-approve-1814-ascii.txt'))?.meters)?.pct).toBe(6)
    expect(parseOmpContext(parseOmpStatus(fx('omp-approve-1814-narrow.txt'))?.meters)?.total).toBe(128_000)
    // No model yet: a status line without a gauge.
    expect(parseOmpStatus(' 󰵗   no-model   demo   master   0/? 󰁨 ──────────\n╰─')).toEqual({ line: '󰵗   no-model   demo   master   0/? 󰁨', meters: null })
  })
  it('reads a gauge in the box\'s top border, not one in older output', () => {
    const screen = 'old output ▶─99%──200K─◀\n╭── ⠦ 4m > ◒ GPT > 📁 ~/project ▶──27%────┃──500K─◀ ⚙ 1 ──╮\n╰─ ─╯'
    expect(parseOmpStatus(screen)).toEqual({ line: '⠦ 4m > ◒ GPT > 📁 ~/project   ⚙ 1', meters: '▶──27%────┃──500K─◀' })
  })
  it('reads the older footer, and nothing on a full-screen panel', () => {
    expect(parseOmpStatus(fx('omp-idle-footer.txt'))).toEqual({ line: '◒ Opus 5.5 👁 · 📁 ~/wherdr · ⑂ omp-support *24 ?4', meters: '◫ 52.7%/1M ⟲ · ⏱ 5h 44% (2h 6m) · 7d 71% (3d 10h)' })
    expect(parseOmpStatus(fx('omp-ask-1814-single.txt'))).toBeNull()
    expect(parseOmpStatus('old output ▶─99%──200K─◀\nUsage\nEsc to close')).toBeNull()
  })
})

describe('parseOmpContext', () => {
  it('reads the percentage and window, estimating tokens from the rounded percentage', () => {
    expect(parseOmpContext('quota ◫ 51.7%/1M other')).toEqual({ pct: 51.7, total: 1_000_000, estimated: 517_000 })
    expect(parseOmpContext('◫ 100%/1.5m')).toEqual({ pct: 100, total: 1_500_000, estimated: 1_500_000 })
    expect(parseOmpContext('▶─0.5%────┆──1M─◀')).toEqual({ pct: 0.5, total: 1_000_000, estimated: 5_000 })
  })
  it('keeps usage above the window after a switch to a smaller model', () => {
    expect(parseOmpContext('▶──200K─120%◀')).toEqual({ pct: 120, total: 200_000, estimated: 240_000 })
  })
  it('invents nothing for missing or invalid gauges', () => {
    for (const text of [null, '', '51%/1M', '◫ 10%/0K', '◫ --/1M', '▶────500K─◀', '▶──27%────◀', '▶──27%──500GB─◀', '▶──27%──500Kgarbage─◀']) expect(parseOmpContext(text)).toBeNull()
  })
})

describe('ompPreviewText', () => {
  const preview = (text: string) => lastLine(ompPreviewText(text))
  it('drops the status line and its gauge, in every layout, keeping what came before', () => {
    expect(preview('Tests pass.\n ⠸ 4s > ⬢ Model > 🗑 ~/demo > ⑂ main ▶────100%──────╎───┃─────1M─\n╰─')).toBe('Tests pass.')
    expect(preview(fx('omp-idle-powerline.txt'))).toBe('Write hello to out.txt')
    expect(preview('Done.\n╭── ⠦ 4m > ◒ GPT > 📁 ~/project ▶──27%────┃──500K─◀ ⚙ 1 ──╮\n│ │\n╰─ ─╯')).toBe('Done.')
    // Older footer: the status line and the gauge rule above the field.
    const footer = ompPreviewText(fx('omp-idle-footer.txt'))
    expect(footer).not.toContain('◫ 52.7%')
    expect(footer).not.toContain('⑂ omp-support')
    expect(lastLine(footer)).not.toBeNull()
  })
  it('shows nothing for the welcome screen: logo, version and tip are chrome', () => {
    expect(lastLine(fx('omp-fresh-nerd.txt'))).toContain('1M')
    expect(preview(fx('omp-fresh-nerd.txt'))).toBeNull()
  })
  it('leaves a screen without omp chrome as it is', () => {
    expect(ompPreviewText('build ok\nuser@host:~$ ')).toBe('build ok\nuser@host:~$ ')
  })
})
