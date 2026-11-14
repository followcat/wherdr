// How long a stop waits (SIGTERM from systemd or launchd, an update, Ctrl+C).
// Nitro's graceful shutdown waits for every unfinished response (a large
// download, a slow request) up to NITRO_SHUTDOWN_TIMEOUT, 30 s by default, then
// gives the 'close' hooks as long again: a restart could cut wherdr for 30 s.
// Capped here, in the server, so it holds however it is started (`wherdr`, or a
// service unit that runs .output/server/index.mjs). Open WebSockets are cut at
// once by Nitro; the clients reconnect on their own.
export const SHUTDOWN_TIMEOUT_MS = 1000

// The environment's own value wins.
export function capShutdownWait(env: Record<string, string | undefined> = process.env) {
  env.NITRO_SHUTDOWN_TIMEOUT ||= String(SHUTDOWN_TIMEOUT_MS)
}
