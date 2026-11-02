// Starts the end-to-end environment (Playwright webServer): a fake HOME with
// neutral transcripts, an empty data dir, the fake Herdr socket server, then
// the built app (.output/) pointed at them. Everything is removed on exit.
import { pdfAuthDb } from './pdfAuth.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeHerdr } from './fake-herdr.mjs'
import { PORT, SOCK_FILE, writeScenario } from './scenario.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const entry = path.join(root, '.output/server/index.mjs')
if (!fs.existsSync(entry)) {
  console.error('e2e: .output/ is missing, run `npm run build` first')
  process.exit(1)
}

// Keep test data in E2E_TMP_DIR when set, otherwise .e2e-tmp (git-ignored).
// The socket uses the system temp dir: Unix socket paths have a size limit.
const tmp = process.env.E2E_TMP_DIR || path.join(root, '.e2e-tmp')
fs.rmSync(tmp, { recursive: true, force: true })
// Keep fixture folders outside the checkout: project/thread names in a
// worktree path must not leak into the app's titles or screenshots.
const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-e2e-'))
const home = path.join(sockDir, 'home')
const data = path.join(tmp, 'data')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(data, { recursive: true })
fs.writeFileSync(path.join(data, 'push.json'), JSON.stringify({ subs: [] }))
// The setup guide covers the app on a first launch: mark it done (for this
// HOST_LABEL) so the other specs reach the app; onboarding.spec.ts reopens it.
fs.writeFileSync(path.join(data, 'onboarding.json'), JSON.stringify({ done: true, host: 'devbox' }))
if (process.env.E2E_PDF_AUTH) fs.writeFileSync(path.join(data, 'auth.json'), JSON.stringify(pdfAuthDb))
const sock = path.join(sockDir, 'herdr.sock')
// The herdr CLI: a fake that only plays the terminal's control session against
// the fake Herdr; everything else (worktrees, machines, notifications…) fails.
const bin = path.join(tmp, 'bin/herdr')
const cli = path.join(root, 'tests/e2e/fake-herdr-cli.mjs')
fs.mkdirSync(path.dirname(bin), { recursive: true })
fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${cli}' '${sock}' "$@"\n`, { mode: 0o755 })
// Where the specs reach the fake Herdr (see fakeHerdr in scenario.mjs).
fs.writeFileSync(SOCK_FILE, sock)

// Agents "installed" in the fake HOME (~/.local/bin), so the Board's Start offers
// the same choice on every machine that runs the suite. They never run.
fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true })
for (const kind of ['claude', 'codex']) fs.writeFileSync(path.join(home, '.local/bin', kind), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
const workspaces = writeScenario(home)
const server = await startFakeHerdr({ sock, workspaces, log: m => console.log(m) })

const app = spawn(process.execPath, [entry], {
  cwd: root,
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    HOME: home,
    DATA_DIR: data,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    HOST_LABEL: 'devbox',
    HERDR_SOCK: sock,
    HERDR_CLIENT_SOCK: path.join(sockDir, 'herdr-client.sock'),
    HERDR_BIN: bin,
    HERDR_WEB_SESSION: 'hwtest',
    // A tailnet name wherdr is reached by: its tailnet's HTTPS images are allowed
    // in replies (markdown-images.spec.ts). No Tailscale runs in the test box.
    HERDR_WEB_ALLOWED_HOSTS: 'box.example.ts.net',
    HERDR_WEB_MACHINES: 'off',
    WHERDR_UPDATE_CHECK: 'off',
    // Delay before a pane gets its size back after a dropped terminal (30 s by default).
    WHERDR_TERM_GRACE_MS: '3000',
    // `herdr integration status` cache (60 s by default), see e2e.integrations.
    WHERDR_INTEGRATION_TTL_MS: '500',
    WHERDR_RUNTIME_DIR: path.join(sockDir, 'run'),
    TZ: 'UTC',
  },
})

// The app first (it may still write its data dir while stopping), then the
// fake Herdr and the temp dirs.
let stopping = false
app.on('exit', (code, signal) => {
  server.close()
  fs.rmSync(sockDir, { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(stopping || signal ? 0 : code ?? 1)
})
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (stopping) return
    stopping = true
    app.kill('SIGTERM')
    setTimeout(() => app.kill('SIGKILL'), 3000).unref()
  })
}
