import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENCODE_PROCS_SCRIPT, parseOpencodeProcs } from '../server/utils/opencodeProcs'

// Runs the real producer against a synthetic proc root: mocked exec answers
// can never catch a producer/parser drift (a base64'd trailing newline made
// every cwd mismatch the catalog once).
describe('opencodeProcs script', () => {
  it('emits a classifiable row whose cwd and argv survive the round trip', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-procs-'))
    try {
      const proc = join(root, 'proc')
      const work = join(root, 'work dir')
      mkdirSync(proc)
      mkdirSync(work)
      writeFileSync(join(proc, 'uptime'), '1439566.59 9999999.99\n')
      writeFileSync(join(proc, 'stat'), 'cpu 0\nbtime 1790000000\n')
      const entry = (pid: number, name: string, cmdline: string) => {
        const d = join(proc, String(pid))
        mkdirSync(d)
        writeFileSync(join(d, 'stat'), `${pid} (${name}) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${pid * 1111}\n`)
        writeFileSync(join(d, 'cmdline'), cmdline)
        writeFileSync(join(d, 'comm'), `${name}\n`)
        symlinkSync(work, join(d, 'cwd'))
      }
      entry(7, 'opencode', 'opencode\0')
      entry(8, 'bash', 'bash\0')
      const stdout = await new Promise<string>((resolve, reject) =>
        execFile('sh', ['-c', OPENCODE_PROCS_SCRIPT, 'sh', proc, '64', '16'], (err, out) => err ? reject(err) : resolve(out)))
      const scan = parseOpencodeProcs(stdout)
      expect(scan.complete).toBe(true)
      expect(scan.uncertain).toEqual([])
      const row = scan.rows.find(r => r.pid === 7)
      expect(row?.argv).toEqual(['opencode'])
      expect(row?.cwd).toBe(work)
      expect(row?.startTicks).toBe(7 * 1111)
      expect(scan.rows.some(r => r.pid === 8)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
