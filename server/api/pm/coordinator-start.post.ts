// { project, program, model }: starts the project's coordinator in its own
// folder, with its role files and a new token (the one before stops working).
// It reaches wherdr on loopback when it runs on this machine; from another
// machine, at wherdr's published address (or the one this request came to,
// when it is not loopback).
import fs from 'node:fs'
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { startCoordinator } from '../../utils/pmCoordinator'
import { pmStore } from '../../utils/pmStore'
import { APP_URL_FILE, ENV_APP_URL } from '../../utils/env'

const LOOPBACK = /^(localhost|127\.|\[::1\])/

export default defineApi(async (event, body) => {
  const port = process.env.NITRO_PORT || process.env.PORT || '7683'
  let published = ''
  try { published = JSON.parse(fs.readFileSync(APP_URL_FILE, 'utf8'))?.url || '' } catch {}
  const here = getRequestURL(event)
  const remote = published || ENV_APP_URL || (LOOPBACK.test(here.hostname) ? '' : here.origin)
  return startCoordinator({ ...coreAdminDeps(), store: pmStore() }, body.project, body, { local: `http://127.0.0.1:${port}`, ...(remote ? { remote: remote.replace(/\/$/, '') } : {}) })
})
