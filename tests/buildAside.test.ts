// WHR-514: a checkout of your own (macOS included) builds aside, as update.sh does.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildAside } from '../scripts/build-aside.mjs'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

it('keeps the running build when the build fails, swaps in a finished one and keeps the previous', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-aside-'))
  dirs.push(dir)
  const write = (p: string, text: string) => { fs.mkdirSync(path.join(dir, p, 'server'), { recursive: true }); fs.writeFileSync(path.join(dir, p, 'server/index.mjs'), text) }
  const read = (p: string) => fs.readFileSync(path.join(dir, p, 'server/index.mjs'), 'utf8')
  write('.output', 'old')
  const envs: NodeJS.ProcessEnv[] = []
  // Nitro writes where it is told to: half a build, then out of memory.
  const failing = (_: string, env: NodeJS.ProcessEnv) => { envs.push(env); fs.mkdirSync(path.join(dir, env.NITRO_OUTPUT_DIR!, 'public'), { recursive: true }); return 1 }
  expect(buildAside({ dir, env: {}, heapLimit: 512 * 1048576, build: failing })).toBe(false)
  expect(envs[0]).toMatchObject({ NITRO_OUTPUT_DIR: '.output.next', NODE_OPTIONS: '--max-old-space-size=1536' })
  expect(read('.output')).toBe('old')
  expect(fs.readdirSync(dir)).toEqual(['.output'])

  const good = (_: string, env: NodeJS.ProcessEnv) => { envs.push(env); write(env.NITRO_OUTPUT_DIR!, 'new'); return 0 }
  expect(buildAside({ dir, env: {}, heapLimit: 4096 * 1048576, build: good })).toBe(true)
  expect(envs[1]!.NODE_OPTIONS).toBeUndefined()
  expect([read('.output'), read('.output.prev')]).toEqual(['new', 'old'])
  expect(fs.readdirSync(dir).sort()).toEqual(['.output', '.output.prev'])
})
