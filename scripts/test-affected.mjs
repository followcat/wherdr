#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import net from 'node:net'

// Reviewed supplements to Vitest's import graph: Nuxt auto-imports, templates,
// CSS and transport boundaries are not ordinary static imports.
export const domains = [
  { name: 'references', source: /(?:reference|Composer|ChatMarkdown|QuotedText|UserText)/i, tests: /(?:reference|Composer|ChatMarkdown|QuotedText|UserText|quote)/i, e2e: ['reference', 'send-message'], reason: 'References cross templates, composer state and the send boundary.' },
  { name: 'guards', source: /(?:server\/api\/(?:prompt|input|choose|menu|nav)|Identity|guardedSend)/i, tests: /(?:guard|Identity|stoppedAgent|agentPrompt|menuRoute)/i, e2e: ['pane-replaced', 'question-reply'], reason: 'Identity and stale actions must be checked through transport.' },
  { name: 'terminal', source: /terminal|server\/routes\/.*ws/i, tests: /terminal/i, e2e: ['interactive-terminal', 'terminal-size'], reason: 'Terminal rendering and websocket lifecycle cross the built app.' },
  { name: 'board', source: /board|machine|TaskPanel|TaskSheet|ProjectGroup/i, tests: /board|machine|TaskPanel|TaskSheet|ProjectGroup/i, e2e: ['machine-groups', 'projects-1x'], reason: 'Board auto-imports and cross-machine navigation need explicit coverage.' },
  { name: 'startup', source: /router|app\.vue|onboarding|app\/plugins/i, tests: /onboarding|directRoute|stateReady/i, e2e: ['startup-hash', 'onboarding'], reason: 'Startup and routing depend on Nuxt registration.' },
  { name: 'appearance', source: /app\/assets\/|themes?\.|font/i, tests: /layout|sheet|CompactDefault|ChatViewRendering|SettingsTyping|Composer|BoardPanel/i, e2e: ['theme', 'sheet-close'], reason: 'CSS and themes affect layout and overlays without import edges.' },
  { name: 'chat-rendering', source: /ChatView|OmpTool|Settings/i, tests: /ChatViewRendering|CompactDefault|SettingsTyping|OmpTool|settings/i, e2e: ['settings-tabs', 'tool-images'], reason: 'Rendering assertions moved from e2e to components; retain integration boundaries.' },
]
const doc = p => /\.(md|rst)$/.test(p) || /^docs\//.test(p)
const test = p => /\.test\.[cm]?[jt]s$/.test(p)
const e2e = p => /^tests\/e2e\/.*\.spec\.ts$/.test(p)
export const literalPattern = p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function parseChanges(output) {
  const fields = output.split('\0'); const paths = []
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++]
    paths.push(fields[i++])
    if (/^[RC]/.test(status)) paths.push(fields[i++])
  }
  return paths.filter(Boolean)
}
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Git command failed')
  return result.stdout
}
export function changedFiles(base, cwd = process.cwd()) {
  let warning
  let committed = []
  try {
    const ancestor = git(['merge-base', 'HEAD', base], cwd).trim()
    committed = parseChanges(git(['diff', '--name-status', '-z', '--find-renames', ancestor, 'HEAD', '--'], cwd))
  } catch {
    warning = `Cannot resolve merge-base with ${base}; fetch the target branch. Selecting broad coverage.`
  }
  return {
    warning,
    files: [...new Set([...committed,
      ...parseChanges(git(['diff', '--name-status', '-z', '--find-renames', 'HEAD', '--'], cwd)),
      ...parseChanges(git(['diff', '--cached', '--name-status', '-z', '--find-renames', '--'], cwd)),
      ...git(['ls-files', '--others', '--exclude-standard', '-z'], cwd).split('\0').filter(Boolean),
    ])].sort(),
  }
}
export function inventory(dir = 'tests') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const p = `${dir}/${entry.name}`
    return entry.isDirectory() ? inventory(p) : [p]
  })
}
export function select(files, available, warning) {
  const unit = new Map(); const browser = new Map(); const selectedDomains = new Map(); const related = []
  let broad = Boolean(warning)
  const add = (map, p, reason) => map.set(p, [...new Set([...(map.get(p) || []), reason])])
  for (const file of files) {
    // Rust tests are selected by the conditional engine workflow, not Vitest.
    if (file.startsWith('engine/')) continue
    if (doc(file)) continue
    if ((test(file) || e2e(file)) && available.includes(file)) {
      add(e2e(file) ? browser : unit, file, 'Changed test: run explicitly.'); continue
    }
    const matches = domains.filter(d => d.source.test(file))
    if (!matches.length || /(?:package(?:-lock)?\.json|(?:nuxt|vitest|playwright)\.config|tests\/e2e\/|app\/plugins\/|transport)/.test(file)) broad = true
    if (available.includes(file) && !test(file) && !e2e(file)) related.push(file)
    for (const d of matches) {
      selectedDomains.set(d.name, d.reason)
      for (const p of available) {
        if (test(p) && d.tests.test(p)) add(unit, p, d.reason)
        if (d.e2e.some(name => p === `tests/e2e/${name}.spec.ts`)) add(browser, p, d.reason)
      }
    }
  }
  if (broad) {
    const reason = warning || 'Unknown, deleted test or shared infrastructure: conservative fallback.'
    selectedDomains.set('fallback', reason)
    for (const p of available) if (test(p)) add(unit, p, reason)
    const smoke = 'tests/e2e/startup-hash.spec.ts'
    if (available.includes(smoke)) add(browser, smoke, reason)
  }
  if (files.some(p => !doc(p) && !p.startsWith('engine/')) && !unit.size && !browser.size) throw new Error('Unexpected empty selection; update the domain table.')
  return { files, domains: Object.fromEntries(selectedDomains), related: broad ? [] : related, tests: Object.fromEntries(unit), e2e: Object.fromEntries(browser), broad, warning }
}
function assertFocusedE2E(specs) {
  const all = inventory().filter(e2e)
  if (all.length > 1 && all.every(p => specs.includes(p))) {
    throw new Error('Refusing the full Playwright suite locally; leave it to CI and review a smaller selection.')
  }
}
function run(command, args, env = process.env) {
  const result = spawnSync('flock', ['/tmp/wherdr-heavy.lock', command, ...args], { stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`)
}
async function freePort() {
  for (let port = 7690; port <= 7699; port++) {
    const free = await new Promise(resolve => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return String(port)
  }
  throw new Error('No free E2E_PORT in 7690–7699')
}
export async function main(args = process.argv.slice(2)) {
  let base; let dry = false; let project = 'chromium-phone'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base') base = args[++i]
    else if (args[i] === '--dry-run') dry = true
    else if (args[i] === '--safari') project = 'webkit-phone'
    else throw new Error(`Unknown option: ${args[i]}`)
  }
  if (!base || base.startsWith('-')) throw new Error('Usage: npm run test:affected -- --base <target-branch> [--dry-run] [--safari]')
  const changes = changedFiles(base)
  const plan = select(changes.files, [...new Set([...inventory(), ...changes.files.filter(p => existsSync(p))])], changes.warning)
  console.log(JSON.stringify({ ...plan, project }, null, 2))
  if (plan.broad) console.log('CI must run the complete reduced suite. Local fallback adds all Vitest tests and a startup e2e smoke; review additional journeys manually.')
  if (!plan.files.length && !plan.warning) console.log('No changed files.')
  else if (!Object.keys(plan.tests).length && !Object.keys(plan.e2e).length) console.log('Documentation or engine only: no JS tests or browser required.')
  if (dry) return
  assertFocusedE2E(Object.keys(plan.e2e))
  const tests = Object.keys(plan.tests)
  // Explicit domain tests run once below; related supplies only additional tests.
  // An empty related graph is allowed because explicit coverage is already selected.
  if (plan.related.length) run('npx', ['--no-install', 'vitest', 'related', '--run', '--passWithNoTests', ...tests.flatMap(p => ['--exclude', p]), ...plan.related.map(p => `./${p}`)])
  if (tests.length) run('npx', ['--no-install', 'vitest', 'run', ...tests])
  const specs = Object.keys(plan.e2e)
  if (specs.length) {
    const env = { ...process.env, E2E_SCOPE: 'full' }
    // One lock covers build and browser run, including the shared .e2e-tmp directory.
    run(process.execPath, [fileURLToPath(import.meta.url), '--execute-e2e', project, ...specs], env)
  }
}
if (process.argv[2] === '--execute-e2e') {
  const [, , , project, ...specs] = process.argv
  if (!['chromium-phone', 'webkit-phone'].includes(project) || !specs.length || specs.some(p => !e2e(p) || !existsSync(p))) {
    console.error('Refusing an empty or invalid e2e selection.'); process.exit(1)
  }
  assertFocusedE2E(specs)
  const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status || 1)
  const port = await freePort()
  const result = spawnSync('npx', ['--no-install', 'playwright', 'test', ...specs.map(p => `${literalPattern(p)}$`), '--project', project], { stdio: 'inherit', env: { ...process.env, E2E_PORT: port } })
  process.exit(result.status ?? 1)
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
