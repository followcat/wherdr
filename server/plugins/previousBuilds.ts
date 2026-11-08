// Keeps this build's /_nuxt files for after the next update, and lists the
// previous builds still served (server/utils/previousBuilds.ts).
import path from 'node:path'
import { DATA_DIR } from '../utils/env'
import { builtPublicDir, currentBuildId, keepBuild, previousBuildDirs } from '../utils/previousBuilds'

export default defineNitroPlugin(() => {
  // Not import.meta.url: Nitro's chunks see a placeholder at startup. The
  // package root the CLI sets, or the server's entry (npm start).
  const root = process.env.WHERDR_ROOT
  const publicDir = (root && builtPublicDir(path.join(root, '.output', 'server', 'index.mjs')))
    || (process.argv[1] && builtPublicDir(process.argv[1]))
  const id = publicDir && currentBuildId(publicDir)
  if (!publicDir || !id) return
  try { previousBuildDirs.splice(0, Infinity, ...keepBuild(publicDir, path.join(DATA_DIR, 'builds'), id)) }
  catch (err) { console.warn('[wherdr] previous builds not kept:', (err as Error).message) }
})
