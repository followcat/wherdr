#!/usr/bin/env node
// `npm run build:aside`: the build of a checkout of your own (macOS included),
// done as update.sh does it. Nitro empties its output folder when a build
// starts, so `npm run build` in place leaves no server when it fails or is
// interrupted, and the running one loses its lazy chunks. This builds into
// .output.next and swaps it in only once built, the previous build kept as
// .output.prev for a rollback.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'
import { fileURLToPath } from 'node:url'
import { BUILD_HEAP_MB, NEXT_OUTPUT } from './install-v3-beside-v2.mjs'

const npmBuild = (dir, env) => spawnSync('npm', ['run', 'build'], { cwd: dir, env, stdio: 'inherit', shell: process.platform === 'win32' }).status

/** true once the new build runs from .output; false leaves .output as it was. */
export function buildAside({ dir = process.cwd(), env = process.env, heapLimit = v8.getHeapStatistics().heap_size_limit, build = npmBuild } = {}) {
  const at = name => path.join(dir, name)
  const drop = () => fs.rmSync(at(NEXT_OUTPUT), { recursive: true, force: true })
  drop()
  const buildEnv = { ...env, NITRO_OUTPUT_DIR: NEXT_OUTPUT }
  // Small machines: Node's default heap is too small for the build.
  if (heapLimit < BUILD_HEAP_MB * 1024 * 1024) buildEnv.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --max-old-space-size=${BUILD_HEAP_MB}`.trim()
  if (build(dir, buildEnv) !== 0 || !fs.existsSync(at(`${NEXT_OUTPUT}/server/index.mjs`))) { drop(); return false }
  fs.rmSync(at('.output.prev'), { recursive: true, force: true })
  if (fs.existsSync(at('.output'))) fs.renameSync(at('.output'), at('.output.prev'))
  fs.renameSync(at(NEXT_OUTPUT), at('.output'))
  return true
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const ok = buildAside()
  console.log(ok
    ? 'OK built into .output (the previous build kept in .output.prev): restart wherdr to run it'
    : 'ERROR build-failed: the running build (.output) is unchanged')
  process.exit(ok ? 0 : 1)
}
