import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic, writeFileAtomicSync } from '../server/utils/atomicWrite'

describe('atomic writes', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a write cut halfway leaves the old file whole and no temporary file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'))
    const file = path.join(dir, 'f.json')
    try {
      await writeFileAtomic(file, 'old\n')
      const real = fs.promises.writeFile
      // Half of the new data reaches the disk, then the write fails (a full disk).
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (p, d) => { await real(p, String(d).slice(0, 3)); throw new Error('ENOSPC') })
      await expect(writeFileAtomic(file, 'new content\n')).rejects.toThrow('ENOSPC')
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('ENOSPC') })
      expect(() => writeFileAtomicSync(file, 'new content\n')).toThrow('ENOSPC')
      expect(fs.readFileSync(file, 'utf8')).toBe('old\n')
      expect(fs.readdirSync(dir)).toEqual(['f.json'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
