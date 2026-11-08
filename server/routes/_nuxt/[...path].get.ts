// A /_nuxt file the current build lacks (the static handler lets it through,
// nuxt.config.ts): served from a previous build when one still has it
// (server/utils/previousBuilds.ts), a 404 otherwise.
import fs from 'node:fs'
import path from 'node:path'
import { previousBuildDirs, previousBuildFile } from '../../utils/previousBuilds'

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json',
}

export default defineEventHandler((event) => {
  const file = previousBuildFile(previousBuildDirs, getRouterParam(event, 'path') || '')
  if (!file) {
    setResponseHeader(event, 'cache-control', 'no-store')
    throw createError({ statusCode: 404 })
  }
  setResponseHeader(event, 'content-type', TYPES[path.extname(file)] || 'application/octet-stream')
  return sendStream(event, fs.createReadStream(file))
})
