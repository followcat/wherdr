// wherdr-opencode-identity — optional, INACTIVE-by-default TUI plugin.
// Activation requires BOTH: this package named in the user's own cli.json
// "plugins" AND ctx.options.enabled === true. Without either, setup does no
// filesystem/socket/process work at all. Read-on-connect identity frame
// only — no navigation, command, request, signal or log channel.
import { Plugin } from '@opencode/plugin/tui'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { startProducer, SUPPORTED_APP_VERSION } from './identity'
import type { FsLike } from './identity'

// THIS process's own /proc starttime — the instance generation bound into
// every frame; null on non-Linux or an unreadable stat (producer stays off)
function selfGen(): string | null {
  try {
    const s = fs.readFileSync('/proc/self/stat', 'utf8')
    return s.slice(s.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? null
  } catch { return null }
}

export default Plugin.define({
  id: 'wherdr.opencode-identity',
  setup(ctx: any) {
    // entry guard BEFORE any runtime metadata seam (pid/getuid/proc/random):
    // no explicit opt-in or an unsupported observed version => inert now,
    // deps object below is never even evaluated
    if (ctx?.options?.enabled !== true) return undefined
    if (ctx?.app?.version !== SUPPORTED_APP_VERSION) return undefined
    const r = startProducer(ctx, {
      env: process.env,
      fs: fs as unknown as FsLike,
      net: { createServer },
      randomBytes,
      now: () => Date.now(),
      pid: process.pid,
      uid: typeof process.getuid === 'function' ? process.getuid() : -1,
      gen: selfGen,
    })
    return r.off ? undefined : r.cleanup   // official setup() cleanup
  },
})
