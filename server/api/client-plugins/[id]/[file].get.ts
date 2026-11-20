import fsp from 'node:fs/promises'
import { pluginFile } from '../../../utils/clientPlugins'

// A plugin's file (its ESM bundle), same origin, so the page's CSP allows it.
// `<id>@<commit>` is the same folder: the commit only makes the URL new per update.
export default defineEventHandler(async (event) => {
  const id = String(getRouterParam(event, 'id')).replace(/@[0-9a-f]{0,40}$/, '')
  const file = pluginFile(id, String(getRouterParam(event, 'file')))
  if (!file) throw createError({ statusCode: 400, statusMessage: 'Bad plugin file' })
  let body: string
  try { body = await fsp.readFile(file, 'utf8') } catch { throw createError({ statusCode: 404, statusMessage: 'Not found' }) }
  setHeader(event, 'content-type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8')
  setHeader(event, 'cache-control', 'no-store')
  return body
})
