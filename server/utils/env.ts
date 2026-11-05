// Settings read from the environment (same variables as the old server.js).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PANE_RE as SHARED_PANE_RE } from '../../shared/ids'
import { userPath } from '../../bin/lib/userpath.mjs'

const env = process.env

export const HOME = env.HOME || os.homedir()
// On the host, the user's real PATH (bin/lib/userpath.mjs): a login service
// starts wherdr with a short system PATH, and what wherdr runs (herdr-projects,
// git, gh, tailscale) must find the agents and tools in user folders. The
// runtime that runs wherdr stays first, as the login service puts it.
env.PATH = userPath({ env, home: HOME, first: [path.dirname(process.execPath)] })
export const DATA_DIR = env.DATA_DIR || path.join(process.cwd(), 'data')
// Folder of wherdr's own files (wherdr.env, wherdr.json): set by the CLI
// (bin/lib/core.mjs, wherdrDir), ~/wherdr otherwise.
export const WHERDR_DIR = env.WHERDR_DIR || path.join(HOME, 'wherdr')
export const AGENT_KINDS = (env.AGENT_KINDS || 'pi,claude,codex,gemini,cursor,devin,agy,cline,omp,mastracode,opencode,copilot,kimi,kiro,droid,amp,grok,hermes,kilo,qodercli,qwen,letta,maki,muse').split(',').map(s => s.trim()).filter(Boolean)
// Public address of the app. Push only uses HTTPS URLs as the VAPID subject.
// An HTTPS APP_URL in the environment wins; otherwise the phone address saved
// by Settings › Phone (DATA_DIR/app-url.json) is used, from startup on.
// process.env.APP_URL holds the address in use (hosts.ts reads it too).
export const APP_URL_FILE = path.join(DATA_DIR, 'app-url.json')
export const ENV_APP_URL = /^https:\/\//i.test(env.APP_URL || '') ? env.APP_URL! : ''
// APP_URL as the environment gave it (often http://localhost:<port>/): what
// comes back when the saved phone address is forgotten.
export const BOOT_APP_URL = env.APP_URL || ''
export function savedAppUrl(): string {
  try {
    const url = JSON.parse(fs.readFileSync(APP_URL_FILE, 'utf8'))?.url
    return typeof url === 'string' && /^https:\/\//i.test(url) ? url : ''
  } catch { return '' }
}
if (!ENV_APP_URL && savedAppUrl()) env.APP_URL = savedAppUrl()
export const appUrl = () => env.APP_URL || 'mailto:herdr-web@localhost'
// Machine name shown in the app ("<HOST_LABEL> · herdr"); empty = "herdr".
export const HOST_LABEL = (env.HOST_LABEL || os.hostname()).trim().slice(0, 40)
// User name of the passkeys created by the app.
export const PASSKEY_USER = (env.PASSKEY_USER || 'wherdr').trim().slice(0, 64)
export const POLL_MS = Number(env.POLL_MS || 1000)
// How often the addresses `tailscale serve` publishes for wherdr are read
// again (server/utils/phone.ts): a new one is enabled, a removed one refused.
export const TAILNET_REFRESH_MS = Number(env.TAILNET_REFRESH_MS || 30000)
// Confirmation delay before notifying: an agent's state may flicker
// (working -> idle -> working between two tools).
export const NOTIFY_SETTLE_MS = Number(env.NOTIFY_SETTLE_MS || 4000)
// Photos sent from the phone: the agent reads them by their path on the host.
export const UPLOAD_DIR = env.UPLOAD_DIR || path.join(HOME, '.cache/herdr-web/uploads')
export const UPLOAD_TTL_MS = 7 * 86400000
// Other files attached to a message (PDF, text, code…): same 7-day purge.
export const ATTACH_DIR = env.ATTACH_DIR || path.join(HOME, '.cache/herdr-web/files')
// Arguments to "resume the last conversation" at launch.
export const RESUME_ARGS: Record<string, string[]> = { claude: ['--continue'], codex: ['resume', '--last'] }

// Herdr identifiers: w1…w9, wA, wB… (not only digits), prefixed with
// "<machine>~" for a remote machine (see shared/ids.ts).
export const PANE_RE = SHARED_PANE_RE

export const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)
