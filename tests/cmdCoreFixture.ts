// Neutral wire fixtures shared by the Command Code core-locator spec and the
// upcoming fake-core wrapper tests. Synthetic machine only: all IO is wire
// fixtures through a fake ShellExec keyed on the real script constants — no
// real /proc, no real home, no localShell. Stands alone: never imports the
// locator under test.
import { AGENT_CENSUS_SCRIPT } from '../server/utils/agentProcesses'
import { CMD_FILES_SCRIPT } from '../server/utils/commandCodeFiles'
import { CMD_HEADERS_SCRIPT } from '../server/utils/commandCodeHeaderRecords'
import type { ShellExec } from '../server/utils/fsx'

export { AGENT_CENSUS_SCRIPT, CMD_FILES_SCRIPT, CMD_HEADERS_SCRIPT }

export const HOME = '/home/user'
export const ROOT = `${HOME}/.commandcode/projects`
export const WORK = '/w/proj'
export const OTHER = '/w/other'
export const BORN = 1767225723464 // ticks 12345 + up 500.12 under H below
export const U1 = '01234567-89ab-cdef-0123-456789abcdef'
export const U2 = '11111111-2222-4333-8444-555555555555'
export const U3 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
export const PKG = '/x/node_modules/command-code/dist/index.mjs'
export const ENTRY: [string, string][] = [['/x/bin/cmd', PKG]]

export const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
export const H = 'H 100 1767225600 1\n'
export const S = (pid: number, o: { ppid?: number, ticks?: string, up?: string, wall?: string, comm?: string, argv?: string[], cwd?: string | null } = {}) =>
  `S ${pid} ${o.ppid ?? 1} ${o.ticks ?? '12345'} ${o.up ?? '500.12'} ${o.wall ?? '1767226100.123456789'} ${b64(o.comm ?? 'node')} ${b64((o.argv ?? ['node', '/x/bin/cmd']).join('\0') + '\0')} ${o.cwd === null ? '' : b64((o.cwd ?? WORK) + '\n')} ${b64('/usr/bin/node\n')} ${b64(ENTRY.map(([r, s]) => `${r}\x01${s}\x01`).join(''))}\n`
export const T = (n: number, r: number, o = 0, u = 0) => `T ${n} ${r} ${o} ${u}\n`
export const retitled = (pid: number, o: { cwd?: string, ticks?: string } = {}) => S(pid, { comm: 'command-code', argv: ['command-code'], cwd: o.cwd, ticks: o.ticks }) // launch argv lost -> argvExact false

export const st = (m: string, ino = 42) => `7 ${m} ${ino} regular file`
export const F = (dir: string, id: string) => `${ROOT}/${dir}/${id}.jsonl`
export const filesWire = (recs: [string, string][]) => `H\n${recs.map(([p, s]) => `R\x01${b64(p)}\x01${s}`).join('\n')}\nT ${recs.length} ${recs.length} ${recs.length} 0\n`
export const sess = (id: string, cwd = WORK) => `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\nevent\n`
// Observed stat must equal listing stat; every requested path gets a record.
export const hdrs = (tbl: Record<string, { st: string, body: string }>) => (args: string[]) => {
  const rs = args.slice(1).map(p => tbl[p]).filter(Boolean).length
  return `H\n${args.slice(1).map(p => tbl[p] ? `R\x01${b64(p)}\x01${tbl[p].st}\x01${b64(tbl[p].body)}` : `E\x01${b64(p)}\x01gone`).join('\n')}\nT ${rs} ${args.length - 1 - rs} ${rs === args.length - 1 ? 0 : 2}\n`
}

export const POST = '1767226000.5' // mtimeMs 1767226000500 > BORN, < firstObs
export const POSTOBS = '1767226200.5' // post-observation write (> obs wall 1767226100.124)
export const POST2 = '1767226500.5'
export const POST3 = '1767226800.5'
export const PRE = '1700000000.5' // pre-birth
export const AT = '1767225723.464' // exactly the birth bound
export const GAP = '1767225800.5' // in the fork->exec gap: > old-shell birth, < firstObs

export const stub = (o: { census?: string, files?: string, headers?: (a: string[]) => string, code?: number }) => {
  const calls = { census: 0, files: 0, headers: 0 }
  const exec: ShellExec = async (script, args = []) => {
    if (script === AGENT_CENSUS_SCRIPT) { calls.census++; return { code: o.code ?? 0, stdout: Buffer.from(o.census ?? `${H}T 0 0 0 0\n`), stderr: '' } }
    if (script === CMD_FILES_SCRIPT) { calls.files++; return { code: 0, stdout: Buffer.from(o.files ?? 'H\nT 0 0 0 0\n'), stderr: '' } }
    if (script === CMD_HEADERS_SCRIPT) { calls.headers++; return { code: 0, stdout: Buffer.from(o.headers?.(args ?? []) ?? 'H\nT 0 0 0\n'), stderr: '' } }
    return { code: 1, stdout: Buffer.alloc(0), stderr: 'x' }
  }
  return { exec, calls }
}
export const clock = () => { let t = 0; return { now: () => t, set: (ms: number) => { t = ms }, advance: (ms: number) => { t += ms } } }
// Every legitimate detail is an explicit live terminal — never defaulted.
export const live = (d: object) => ({ state: 'live', ...d })
