import { describe, expect, it } from 'vitest'
import { parseCapacity, pressureOf } from '../shared/pm/capacity'
import { DEFAULT_MEMORY, memoryLine } from '../shared/pm/memory'
import { misfit } from '../shared/pm/placement'
import { WEIGHT_DEFAULTS, type Weight } from '../shared/pm/weight'

// CAPACITY_SCRIPT's output on each OS (trimmed real samples).
const linux = `cores: 8
loadavg: 2.13 1.80 1.52 3/1234 56789
MemTotal:       32768000 kB
MemFree:         1024000 kB
MemAvailable:    9318400 kB
SwapTotal:       2097152 kB
SwapFree:        2031616 kB`

const macos = `cores: 10
memsize: 17179869184
loadavg: { 3.42 2.97 2.71 }
memfree: 45
pressure: 2
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               65536.
Pages active:                            300000.
Pages inactive:                          131072.
Pages speculative:                        32768.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                          32768.
Pages occupied by compressor:             65536.`

// An 18 GB Mac at 46 % free by macOS (pressure normal) whose free + inactive
// pages make only 4.2 GB: the compressor holds 5.6 GB macOS can give back.
const mac18 = (memfree: number) => `cores: 12
memsize: 19327352832
loadavg: { 8.02 7.80 7.51 }
memfree: ${memfree}
pressure: 1
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               20000.
Pages active:                            350000.
Pages inactive:                          230000.
Pages speculative:                         5200.
Pages wired down:                        150000.
Pages purgeable:                          20000.
Pages occupied by compressor:            367000.`

describe('machine capacity', () => {
  it('reads Linux', () => {
    expect(parseCapacity(linux)).toEqual({ cores: 8, load1: 2.13, total: 32000, available: 9100, swapTotal: 2048, swapFree: 1984 })
  })

  it('reads macOS: available is its memory free percentage of the RAM, else the pages it can reclaim', () => {
    // 45 % of 16 GB.
    expect(parseCapacity(macos)).toEqual({ cores: 10, load1: 3.42, total: 16384, available: 7373, swapTotal: 0, swapFree: 0, pressure: 'normal' })
    expect(memoryLine(parseCapacity(macos), DEFAULT_MEMORY, 1)).toBe('pressure normal, ≈7.2 GB available of 16.0 GB · 10 cores, load 3.4 · 1 of 10 agents · go')
    // No percentage: (65536 + 131072 + 32768 + 32768 + 65536 / 2) × 16 KB = 4608 MB.
    expect(parseCapacity(macos.replace('memfree: 45\n', ''))?.available).toBe(4608)
  })

  it('places on macOS by its pressure and available memory: normal fits standard, warn light only, critical nothing', () => {
    const fits = (memfree: number) => {
      const capacity = parseCapacity(mac18(memfree))
      const c = { key: 'mac', label: 'mac', online: true, settings: DEFAULT_MEMORY, capacity, running: [WEIGHT_DEFAULTS.standard, WEIGHT_DEFAULTS.standard] }
      return (['light', 'standard', 'heavy'] as Weight[]).filter(w => !misfit(c, w, WEIGHT_DEFAULTS[w]))
    }
    expect(parseCapacity(mac18(46))?.available).toBe(8479)
    expect(fits(46)).toEqual(['light', 'standard', 'heavy'])
    expect(fits(15)).toEqual(['light'])
    expect(fits(8)).toEqual([])
  })

  it('reads the macOS pressure from the free percentage; the kernel level counts when critical or alone', () => {
    // A healthy Mac whose kernel level says warn (2) at 45 % free: normal.
    expect([pressureOf(45, '2'), pressureOf(15, '1'), pressureOf(5, '1'), pressureOf(45, '4')]).toEqual(['normal', 'warn', 'critical', 'critical'])
    expect([pressureOf(null, '2'), pressureOf(null, '')]).toEqual(['warn', undefined])
    expect(parseCapacity(macos.replace('memfree: 45\n', ''))?.pressure).toBe('warn')
  })

  it('is unknown when the memory cannot be read', () => {
    expect(parseCapacity('')).toBeNull()
    expect(parseCapacity('cores: 4\nMach Virtual Memory Statistics: (page size of 4096 bytes)')).toBeNull()
    expect(memoryLine(null, DEFAULT_MEMORY, 0)).toBe('memory unknown · 0 agents · go')
  })
})
