// A machine's capacity: cores, memory, swap or pressure, and load, read live through one
// POSIX script that works on Linux and macOS. Parsing is pure, so each OS's
// output has its own unit test.

// MB, except cores and the 1-minute load average. cores and load1 are 0 when unknown.
// pressure: macOS only (its swap grows on demand, so its share used says little).
export interface MachineCapacity { cores: number, total: number, available: number, swapTotal: number, swapFree: number, load1: number, pressure?: Pressure }
export type Pressure = 'normal' | 'warn' | 'critical'
// macOS pressure from kern.memorystatus_level, the system-wide free memory
// percentage `memory_pressure -Q` prints: under WARN_FREE % warn, under
// CRITICAL_FREE % critical. The kernel's own level
// (kern.memorystatus_vm_pressure_level: 1, 2, 4) often says warn on a Mac with
// plenty free, so it counts only when critical, or when the percentage is missing.
export const WARN_FREE = 20
export const CRITICAL_FREE = 10
const LEVEL: Record<string, Pressure> = { 1: 'normal', 2: 'warn', 4: 'critical' }
export function pressureOf(freePercent: number | null, level: string | undefined): Pressure | undefined {
  const kernel = LEVEL[level ?? '']
  if (freePercent === null) return kernel
  if (kernel === 'critical' || freePercent < CRITICAL_FREE) return 'critical'
  return freePercent < WARN_FREE ? 'warn' : 'normal'
}

// Linux: nproc, /proc/loadavg, /proc/meminfo. macOS: sysctl (memory free percentage, pressure level) and vm_stat.
export const CAPACITY_SCRIPT = `if [ "$(uname -s)" = Darwin ]; then
  echo "cores: $(sysctl -n hw.ncpu)"
  echo "memsize: $(sysctl -n hw.memsize)"
  echo "loadavg: $(sysctl -n vm.loadavg)"
  echo "memfree: $(sysctl -n kern.memorystatus_level 2>/dev/null)"
  echo "pressure: $(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)"
  vm_stat
else
  echo "cores: $(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"
  echo "loadavg: $(cat /proc/loadavg)"
  cat /proc/meminfo
fi`

const field = (text: string, key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(text)?.[1]?.trim()
const num = (s?: string) => { const n = Number.parseFloat(s ?? ''); return Number.isFinite(n) ? n : null }
const head = (text: string) => ({ cores: Math.max(0, Math.round(num(field(text, 'cores')) ?? 0)), load1: num(field(text, 'loadavg')?.replace(/^\{\s*/, '')) ?? 0 })

// Linux: /proc/meminfo in kB. null when MemTotal or MemAvailable is missing.
export function parseLinux(text: string): MachineCapacity | null {
  const mb = (k: string) => { const n = num(field(text, k)); return n === null ? null : Math.round(n / 1024) }
  const total = mb('MemTotal'), available = mb('MemAvailable')
  if (total === null || available === null) return null
  return { ...head(text), total, available, swapTotal: mb('SwapTotal') ?? 0, swapFree: mb('SwapFree') ?? 0 }
}

// macOS: available is macOS's own estimate, the memory free percentage
// (kern.memorystatus_level, as `memory_pressure -Q` prints it) × RAM: it counts
// what macOS can reclaim or compress. Without it: (free + inactive + speculative
// + purgeable pages + half the pages the compressor occupies) × page size.
// No swap figures: the pressure (pressureOf) stands for them (unset when unreadable).
export function parseMacos(text: string): MachineCapacity | null {
  const bytes = num(field(text, 'memsize'))
  const page = num(/page size of (\d+) bytes/.exec(text)?.[1])
  const pages = (k: string) => num(field(text, `Pages ${k}`)) ?? 0
  if (bytes === null || page === null || field(text, 'Pages free') === undefined) return null
  const freePercent = num(field(text, 'memfree'))
  const pressure = pressureOf(freePercent, field(text, 'pressure'))
  const available = freePercent !== null
    ? bytes * freePercent / 100
    : (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable') + pages('occupied by compressor') / 2) * page
  return { ...head(text), total: Math.round(bytes / 2 ** 20), available: Math.round(available / 2 ** 20), swapTotal: 0, swapFree: 0, ...(pressure ? { pressure } : {}) }
}

// CAPACITY_SCRIPT's output, from either OS: null when it cannot be read.
export const parseCapacity = (text: string) => (/^Mach Virtual Memory/m.test(text) ? parseMacos(text) : parseLinux(text))
