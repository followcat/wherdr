// Content of the browser demo (wherdr.dev/demo): an invented session with two
// projects, four agents and a dev server. Everything here is fiction, in
// English, with no real path, machine, person or conversation.
import type { ChatItem, ModelInfo, OmpToolView, Pane, Quotas, Tab, Workspace } from '#shared/types'

export const HOME = '/Users/demo'
const REPO = `${HOME}/code/acme-api`
const WT = `${HOME}/.herdr/worktrees/acme-api`
const WEB = `${HOME}/code/acme-web`

export const COORD = 'w1:p1'
export const CODEX = 'w2:p1'
export const OMP = 'w3:p1'
export const CLAUDE_WEB = 'w4:p1'
export const DEV_SERVER = 'w4:p2'

export const MODELS: Record<string, ModelInfo> = {
  claude: { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', effort: 'high' },
  codex: { id: 'gpt-5-codex', label: 'GPT-5 Codex', effort: 'medium' },
  omp: { id: 'claude-opus-4-1', label: 'Opus 4.1', effort: 'medium' },
}

export function workspaces(): Workspace[] {
  return [
    { id: 'w1', label: 'acme-api', number: 1, status: null, worktree: false },
    { id: 'w2', label: 'Per-key rate limits', number: 2, status: null, worktree: true, repo: REPO, repoName: 'acme-api', branch: 'hp/acme-api/t-0012-rate-limits' },
    { id: 'w3', label: 'Fix the flaky CSV export test', number: 3, status: null, worktree: true, repo: REPO, repoName: 'acme-api', branch: 'hp/acme-api/t-0013-flaky-export' },
    { id: 'w4', label: 'acme-web', number: 4, status: null, worktree: false, repo: WEB, repoName: 'acme-web', branch: 'main' },
  ]
}

const one = (ws: string, pane: string): Tab => ({
  id: `${ws}:t1`, workspace: ws, label: '1', number: 1,
  layout: { tab: `${ws}:t1`, workspace: ws, zoomed: false, focused: pane, area: { x: 0, y: 0, width: 160, height: 48 }, panes: [{ pane, rect: { x: 0, y: 0, width: 160, height: 48 } }], splits: [] },
})

export function tabs(): Tab[] {
  return [
    one('w1', COORD), one('w2', CODEX), one('w3', OMP),
    {
      id: 'w4:t1', workspace: 'w4', label: '1', number: 1,
      layout: {
        tab: 'w4:t1', workspace: 'w4', zoomed: false, focused: CLAUDE_WEB, area: { x: 0, y: 0, width: 160, height: 48 },
        panes: [{ pane: CLAUDE_WEB, rect: { x: 0, y: 0, width: 96, height: 48 } }, { pane: DEV_SERVER, rect: { x: 97, y: 0, width: 63, height: 48 } }],
        splits: [{ path: '', direction: 'right', ratio: 0.6, rect: { x: 0, y: 0, width: 160, height: 48 } }],
      },
    },
  ]
}

const pane = (p: Partial<Pane> & Pick<Pane, 'id' | 'workspace' | 'agent' | 'cwd'>): Pane => ({
  tab: `${p.workspace}:t1`, tabLabel: null, name: null, label: null, status: 'idle', title: null, agentSession: `demo-${p.id}`, ...p,
})

export function panes(now: number): Pane[] {
  return [
    pane({ id: COORD, workspace: 'w1', agent: 'claude', cwd: `${HOME}/.herdr-projects/data/coordinator/default/chat`, status: 'idle', model: MODELS.claude, stateSeq: 4, bornAt: now - 3600_000, preview: 'ACME-API-12 and ACME-API-13 are under way. I will tell you when one is ready to review.' }),
    pane({ id: CODEX, workspace: 'w2', agent: 'codex', cwd: `${WT}/acme-api-12-rate-limits`, status: 'working', model: MODELS.codex, stateSeq: 7, bornAt: now - 1800_000 }),
    pane({ id: OMP, workspace: 'w3', agent: 'omp', cwd: `${WT}/acme-api-13-flaky-export`, status: 'blocked', model: MODELS.omp, stateSeq: 9, bornAt: now - 1500_000, prompt: approval('npm test -- export.spec.ts --repeat 20') }),
    pane({ id: CLAUDE_WEB, workspace: 'w4', agent: 'claude', cwd: WEB, status: 'done', model: MODELS.claude, stateSeq: 8, bornAt: now - 2400_000 }),
    pane({ id: DEV_SERVER, workspace: 'w4', agent: null, cwd: WEB, command: 'npm run dev', status: null, agentSession: null }),
  ]
}

// omp's tool approval dialog, as wherdr reads it from the screen.
export function approval(command: string): NonNullable<Pane['prompt']> {
  return { question: 'Allow tool: bash', cursor: 0, options: [{ label: 'Approve', hint: null }, { label: 'Deny', hint: null }], detail: { tool: 'bash', command } }
}

const omp = (title: string, target: string, extra: Partial<OmpToolView> = {}): OmpToolView => ({ title, target, ...extra })

// Conversations already on screen when the demo opens.
export function conversations(now: number): Record<string, ChatItem[]> {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  return {
    [COORD]: [
      { role: 'user', text: 'Plan the 2.3 release: per-key rate limits on the public API, and the CSV export test that fails one run in ten.', ts: at(62) },
      { role: 'tool', name: 'Bash', text: 'herdr-projects list', ts: at(61) },
      { role: 'tool', name: 'Grep', text: 'rateLimit · src/', ts: at(61) },
      { role: 'assistant', text: 'Two independent pieces of work, touching different files, so they can run in parallel:\n\n1. **ACME-API-12 — Rate limits** (Codex): a token bucket per API key in `src/middleware/rateLimit.ts`, `429` with `Retry-After`, limits read from the plan.\n2. **ACME-API-13 — Flaky export test** (omp): `export.spec.ts` depends on the order of rows coming back from the database.\n\nI added both tasks and put an agent on each.', ts: at(60) },
      { role: 'tool', name: 'Bash', text: 'herdr-projects add "Per-key rate limits on the public API" --delegate', ts: at(59) },
      { role: 'tool', name: 'Bash', text: 'herdr-projects add "Fix the flaky CSV export test" --delegate', ts: at(59) },
      { role: 'assistant', text: 'Both agents are on it. Their work is reviewed when they finish, then waits for your approval on the Board.', ts: at(58) },
    ],
    [CODEX]: [
      { role: 'user', text: 'Add per-key rate limits to the public API: a token bucket per key, 429 with Retry-After, limits from the customer plan. Tests included.', ts: at(30) },
      { role: 'tool', name: 'shell', text: "rg -n 'rateLimit|plan.limits' src", ts: at(29) },
      { role: 'tool', name: 'shell', text: 'sed -n 1,80p src/middleware/auth.ts', ts: at(29) },
      { role: 'assistant', text: 'The auth middleware already resolves the API key to its plan, so the limiter can sit right after it and read `req.plan.limits`. I will keep the buckets in memory behind a small `Store` interface, so a Redis store can replace it later.', ts: at(27) },
      { role: 'tool', name: 'apply_patch', text: 'src/middleware/rateLimit.ts', ts: at(25) },
      { role: 'tool', name: 'apply_patch', text: 'src/app.ts', ts: at(24) },
    ],
    [OMP]: [
      { role: 'user', text: 'export.spec.ts fails about one run in ten in CI. Find out why and make it deterministic.', ts: at(25) },
      { role: 'thinking', text: 'The failure message shows the same rows in a different order. The export query has no ORDER BY, so Postgres returns rows in whatever order the plan produces.', ts: at(24), ms: 4200 },
      { role: 'tool', name: 'Read', text: 'src/export/csv.ts', ts: at(24), omp: omp('Read', 'src/export/csv.ts', { ms: 40 }) },
      { role: 'tool', name: 'Grep', text: 'findInvoices', ts: at(23), omp: omp('Grep', 'findInvoices', { scope: 'src', matches: 3, files: 2, ms: 60 }) },
      { role: 'assistant', text: '`findInvoices` has no `ORDER BY`: the rows come back in plan order, which changes when the table is vacuumed. The test compares the CSV line by line, so it fails whenever the order moves.\n\nFix: sort by `issued_at, id` in the query (stable, and what users expect in the file).', ts: at(22) },
      { role: 'tool', name: 'Edit', text: 'src/export/csv.ts', ts: at(21), omp: omp('Edit', 'src/export/csv.ts', { added: 1, removed: 1, diff: true, out: "-  const rows = await db.invoices.find({ accountId })\n+  const rows = await db.invoices.find({ accountId }, { orderBy: ['issued_at', 'id'] })", ms: 30 }) },
      { role: 'assistant', text: 'Now I will run the spec twenty times in a row to make sure the order no longer moves.', ts: at(1) },
      { role: 'tool', name: 'Bash', text: 'npm test -- export.spec.ts --repeat 20', ts: at(1), omp: omp('Bash', 'npm test -- export.spec.ts --repeat 20') },
    ],
    [CLAUDE_WEB]: [
      { role: 'user', text: 'Add a dark mode toggle to the settings page. Follow the system by default and remember the choice.', ts: at(40) },
      { role: 'tool', name: 'Read', text: 'src/pages/settings.vue', ts: at(39) },
      { role: 'tool', name: 'Grep', text: 'prefers-color-scheme · src', ts: at(39) },
      { role: 'tool', name: 'Write', text: 'src/composables/useColorMode.ts', ts: at(38) },
      { role: 'tool', name: 'Edit', text: 'src/pages/settings.vue', ts: at(37) },
      { role: 'tool', name: 'Edit', text: 'src/assets/main.css', ts: at(37) },
      { role: 'tool', name: 'Bash', text: 'Run the unit tests', ts: at(36) },
      { role: 'assistant', text: 'Done. The settings page has an **Appearance** row with three choices:\n\n| Choice | Behaviour |\n|---|---|\n| System | follows `prefers-color-scheme`, live |\n| Light | always light |\n| Dark | always dark |\n\nThe choice is saved in `localStorage` and applied before the first paint, so there is no flash on reload. Tests pass (48/48). **View changes** in the ⋯ menu shows the diff.\n\nShall I open the pull request?', ts: at(35) },
    ],
  }
}

// Steps the Codex thread still has to do when the demo opens: it keeps working
// on its own, then reports.
export const CODEX_FINISH: { after: number, item: ChatItem | null, activity?: string }[] = [
  { after: 4000, item: { role: 'tool', name: 'apply_patch', text: 'test/rateLimit.test.ts', ts: null }, activity: 'Writing tests' },
  { after: 5000, item: { role: 'tool', name: 'shell', text: 'npm test -- rateLimit', ts: null }, activity: 'Running tests' },
  { after: 6000, item: { role: 'assistant', text: 'Rate limits are in:\n\n- `src/middleware/rateLimit.ts`: token bucket per API key, refilled continuously; limits from `req.plan.limits` (60/min on Free, 600/min on Team).\n- Over the limit: `429 Too Many Requests` with `Retry-After` and `RateLimit-Remaining` headers.\n- 9 new tests, including the refill and two keys sharing nothing.\n\nAll 162 tests pass. Ready for review.', ts: null } },
]

export function quotas(now: number): Quotas {
  return {
    claude: { five: { used: 34, resetsAt: now + 132 * 60_000, minutes: 300 }, week: { used: 21, resetsAt: now + 3.4 * 86400_000, minutes: 10080 }, at: now },
    codex: { five: { used: 12, resetsAt: now + 247 * 60_000, minutes: 300 }, week: { used: 46, resetsAt: now + 1.8 * 86400_000, minutes: 10080 }, at: now },
  }
}

// What an agent answers to a message typed in the demo: a short scripted
// turn, picked from the words of the message. `approval`: a command that
// waits for Approve / Deny first.
export interface ScriptedTurn {
  thinking?: string
  steps: { name: string, text: string, omp?: OmpToolView }[]
  approval?: string
  reply: string
  denied: string
}

const has = (text: string, re: RegExp) => re.test(text.toLowerCase())

export function scriptFor(agent: string, text: string, n: number): ScriptedTurn {
  const shell = agent === 'codex' ? 'shell' : 'Bash'
  const tool = (name: string, target: string, view?: Partial<OmpToolView>) =>
    ({ name: agent === 'codex' && name !== 'apply_patch' ? 'shell' : name, text: target, omp: agent === 'omp' ? omp(name, target, view) : undefined })
  // A question ("why…", "how…") is answered, even if it mentions tests; a request
  // phrased as one ("can you run the tests?") is a request.
  if (has(text, /^\s*(why|how|what|explain)\b/)) {
    return {
      thinking: 'Answer from what is already in the code, with the file to look at.',
      steps: [tool('Grep', 'orderBy', { scope: 'src', matches: 4, files: 3, ms: 50 })],
      reply: 'Short version: rows had no defined order, so anything comparing them line by line was flaky. Every query feeding an export now sorts on a unique key (`issued_at, id`), which makes the file stable and diffable.',
      denied: '',
    }
  }
  if (has(text, /\b(test|tests|spec|ci|run)\b/)) {
    return {
      thinking: 'Run the whole suite, not only the file that changed, to catch side effects.',
      approval: 'npm test',
      steps: [tool(shell, 'npm test', { exit: 0, ms: 8400, out: ' ✓ test/export.spec.ts (12)\n ✓ test/rateLimit.test.ts (9)\n ✓ test/webhooks.test.ts (14)\n\n Test Files  23 passed (23)\n      Tests  162 passed (162)', outLines: 6 })],
      reply: 'The full suite passes: **162 tests** in 23 files, 8.4 s. Nothing else depends on the export order.',
      denied: 'OK, I did not run the tests. Tell me when you want me to.',
    }
  }
  if (has(text, /\b(deploy|release|ship|merge|push)\b/)) {
    return {
      approval: 'git push origin HEAD',
      steps: [tool(shell, 'git status --short'), tool(shell, 'git push origin HEAD', { exit: 0, ms: 1900 })],
      reply: 'Pushed the branch. CI is running on it; I will tell you if anything turns red.',
      denied: 'Understood, nothing was pushed. The branch stays local.',
    }
  }
  if (has(text, /\b(diff|change|changes|review)\b/)) {
    return {
      steps: [tool(shell, 'git diff --stat'), tool('Read', 'src/export/csv.ts', { ms: 30 })],
      reply: 'The change is small: one query gets an explicit order. **View changes** in the ⋯ menu at the top shows the diff line by line.',
      denied: '',
    }
  }
  const generic: ScriptedTurn[] = [
    {
      steps: [tool('Read', 'README.md', { ms: 20 }), tool('Grep', 'TODO', { scope: 'src', matches: 2, files: 2, ms: 40 })],
      reply: 'On it. I read the code around it first: the change fits in two files, with a test for each. I will report when it is done.',
      denied: '',
    },
    {
      approval: 'npm run lint -- --fix',
      steps: [tool(shell, 'npm run lint -- --fix', { exit: 0, ms: 2600 })],
      reply: 'Done, and lint is clean. In real use this is where you would read the diff and answer from your phone.',
      denied: 'Fine, I left the files untouched.',
    },
  ]
  return generic[n % generic.length]!
}

// Recorded output of the dev server pane (terminal view).
export const DEV_SERVER_OUTPUT = [
  '\x1b[32m❯\x1b[0m npm run dev',
  '',
  '> acme-web@2.3.0 dev',
  '> vite',
  '',
  '',
  '  \x1b[1;32mVITE\x1b[0m \x1b[32mv7.1.4\x1b[0m  ready in \x1b[1m412\x1b[0m ms',
  '',
  '  \x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[0m\x1b[36m/\x1b[0m',
  '  \x1b[2m➜  Network: use --host to expose\x1b[0m',
  '',
  '\x1b[2m10:42:07\x1b[0m \x1b[36m[vite]\x1b[0m \x1b[32mhmr update\x1b[0m \x1b[2m/src/pages/settings.vue\x1b[0m',
  '\x1b[2m10:42:09\x1b[0m \x1b[36m[vite]\x1b[0m \x1b[32mhmr update\x1b[0m \x1b[2m/src/assets/main.css\x1b[0m',
]
