import { execFile } from 'node:child_process'
import { expect, it } from 'vitest'
import { DEVIN_PROCESS_SCRIPT, devinProcesses } from '../server/utils/devinProcesses'

const boot = 1767225600
const snapshot = (args: string[], times = '12345 100 1767225600 500.12 1767226100.123456789') =>
  `100 ${times} ${Buffer.from(args.join('\0') + '\0').toString('base64')}\n`

it('keeps exact NUL-separated argv boundaries and rounds birth uncertainty upward', () => {
  const p = devinProcesses(snapshot(['devin', 'Explain --resume=session-b', '', 'line\nbreak'])).get(100)
  expect(p?.argv).toEqual(['devin', 'Explain --resume=session-b', '', 'line\nbreak'])
  expect(p?.argvExact).toBe(true)
  // One tick after 123.45s plus an uptime sample 3.456789ms before wall time.
  expect(p?.startedAt).toBe(boot * 1000 + 123464)
})

it('does not claim locks from missing, coarse or inconsistent timing metadata', () => {
  for (const times of ['12345 - - - -', '12345 100 1767225600 500.12 0', '12345 0 1767225600 500.12 1767226100.12']) {
    const p = devinProcesses(snapshot(['devin', '-r', 'session-a'], times)).get(100)
    expect(p?.argvExact).toBe(true)
    expect(p?.startedAt).toBeUndefined()
  }
  expect(devinProcesses('100 1 100 1767225600 1 1767225601 ' + Buffer.from('devin').toString('base64')).size).toBe(0)
})

it.runIf(process.platform === 'linux')('reads timing and exact argv of this isolated test worker in one shell call', async () => {
  const stdout = await new Promise<string>((resolve, reject) => execFile('sh', ['-c', DEVIN_PROCESS_SCRIPT, 'sh', String(process.pid)], (err, stdout) => err ? reject(err) : resolve(stdout)))
  const p = devinProcesses(stdout).get(process.pid)
  expect(p?.argvExact).toBe(true)
  expect(p?.argv?.[0]).toBe(process.argv[0])
  expect(p?.startedAt).toBeLessThanOrEqual(Date.now())
  expect(Math.abs(p!.startedAt! - (Date.now() - process.uptime() * 1000))).toBeLessThan(2000)
})
