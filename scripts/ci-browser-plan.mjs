#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

export function browserPlan(event, ref) {
  const scope = event === 'schedule' || event === 'workflow_dispatch' || ref.startsWith('refs/tags/') ? 'full' : 'light'
  const include = []
  // Recent light PR runs: Chromium phone 211–284 s/shard with four shards,
  // WebKit phone 199–239 s unsharded, before npm/build/browser preparation.
  for (const [project, count] of [['chromium-phone', 6], ['webkit-phone', 2]]) {
    for (let n = 1; n <= count; n++) include.push({ project, shard: `${n}/${count}` })
  }
  include.push({ project: 'chromium-desktop' }, { project: 'webkit-desktop' })
  return { scope, matrix: { include } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = browserPlan(process.env.EVENT, process.env.REF)
  for (const [key, value] of Object.entries(plan)) console.log(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
}
