// First plugin to run: wherdr 3 cannot work without herdr-core. Without
// HC_SOCKET (a 2.x one-tap update that installed wherdr 3 by mistake, a service
// file without it), stop at startup with a clear log line instead of serving an
// app that fails on every request: the updater sees the exit and rolls back.
import { missingHcSocket } from '../utils/core'

export function requireHcSocket(env: NodeJS.ProcessEnv, exit: (code: number) => void, log = console.error) {
  const missing = missingHcSocket(env)
  if (!missing) return
  log(`wherdr: ${missing}`)
  exit(1)
}

export default defineNitroPlugin(() => requireHcSocket(process.env, code => process.exit(code)))
