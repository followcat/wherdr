import { describe, expect, it } from 'vitest'
import { learnedEstimates, parsePeaks } from '../shared/pm/peaks'
import { weightsLine } from '../shared/pm/weight'

const WT = '~/project/.wherdr/pm/worktrees/P-1'

describe('parsePeaks', () => {
  it('sums the memory of the processes in each worktree (Linux: ps, then find on /proc)', () => {
    const linux = ['p1', 'r1000', 'p10', 'r512000', 'p11', 'r1048576', 'p12', 'r204800', 'p13', 'r9',
      'p1', 'n/', 'p10', `n${WT}`, 'p11', `n${WT}/app`, 'p12', `n${WT}-old`, 'p13', 'n'].join('\n')
    expect(parsePeaks(linux, [WT, '~/project/other'])).toEqual({ [WT]: 1524, '~/project/other': 0 })
  })
  it('reads lsof -F lines on macOS', () => {
    const mac = ['p200', 'r307200', 'p201', 'r102400', 'p200', 'fcwd', `n${WT}`, 'p201', 'fcwd', 'n/tmp'].join('\n')
    expect(parsePeaks(mac, [WT])).toEqual({ [WT]: 300 })
  })
})

describe('learnedEstimates', () => {
  const tasks = [1, 2, 3, 4, 5, 6].map(n => ({ id: `P-${n}`, type: 'task', weight: 'heavy' as const }))
  const run = (n: number, peakMb?: number) => ({ task: `P-${n}`, startedAt: n, ...(peakMb ? { peakMb } : {}) })

  it('keeps the default until 3 runs have a peak, then the largest of the last 5 × 1.15', () => {
    const two = learnedEstimates(null, tasks, [run(1, 2000), run(2, 2400), run(3)])
    expect(two.heavy).toEqual({ mb: 4000, cores: 2, runs: 0 })
    const three = learnedEstimates(null, tasks, [run(1, 2000), run(2, 2400), run(3, 2200)])
    expect(three.heavy).toEqual({ mb: 2760, cores: 2, runs: 3 })
    // The first run's 5000 MB is older than the last 5: it no longer counts.
    const six = learnedEstimates(null, tasks, [run(1, 5000), run(2, 2400), run(3, 2200), run(4, 2000), run(5, 2000), run(6, 2000)])
    expect(six.heavy).toEqual({ mb: 2760, cores: 2, runs: 5 })
    expect(six.light.runs).toBe(0)
    expect(weightsLine(six)).toBe('light ≈ 0.7 GB, 0.25 core (default) · standard ≈ 1.8 GB, 1 core (default) · heavy ≈ 2.7 GB, 2 cores (from 5 runs)')
  })
})
