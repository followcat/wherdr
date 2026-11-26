// Content of the browser demo (wherdr.dev/demo): an invented session with
// Alfred, two projects and their coordinators, three task agents, another
// agent and a dev server (the projects' tasks: projects.ts). Everything here is fiction, in
// English, with no real path, machine, person or conversation.
import type { ChatItem, ModelInfo, OmpToolView, Pane, Quotas, SessionInfo, Tab, Workspace } from '#shared/types'
import type { BacklotMachineView } from '#shared/backlot'
import type { TaskAgent } from '#shared/pm/taskAgents'

export const HOME = '/Users/demo'
const REPO = `${HOME}/code/acme-api`
const WT = `${HOME}/.wherdr/worktrees`
const WEB = `${HOME}/code/acme-web`

export const ALFRED = 'w0:p1'
export const COORD = 'w1:p1'
export const WEB_COORD = 'w5:p1'
export const CODEX = 'w2:p1'
export const OMP = 'w3:p1'
export const CLAUDE_WEB = 'w4:p1'
export const DEV_SERVER = 'w4:p2'
export const STUDIO_PRODUCER = 'w6:p1'
export const STUDIO_ACTOR = 'w6:p2'
export const STUDIO_SESSION = 's0123456789abcdef'

export const MODELS: Record<string, ModelInfo> = {
  claude: { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', effort: 'high' },
  codex: { id: 'gpt-5-codex', label: 'GPT-5 Codex', effort: 'medium' },
  omp: { id: 'claude-opus-4-1', label: 'Opus 4.1', effort: 'medium' },
}

// The demo runs two hc sessions: the main one and a studio session holding the
// Backlot roles, so Home's session switcher shows.
export function sessions(): SessionInfo[] {
  return [
    { key: '', name: 'default', primary: true, status: 'online' },
    { key: STUDIO_SESSION, name: 'studio', primary: false, status: 'online' },
  ]
}

export function workspaces(): Workspace[] {
  return [
    { id: 'w0', label: 'Alfred', number: 0, status: null, worktree: false },
    { id: 'w1', label: 'acme-api', number: 1, status: null, worktree: false },
    { id: 'w2', label: 'Per-key rate limits', number: 2, status: null, worktree: true, repo: REPO, repoName: 'acme-api', branch: 'hp/acme-api/t-0012-rate-limits' },
    { id: 'w3', label: 'Fix the flaky CSV export test', number: 3, status: null, worktree: true, repo: REPO, repoName: 'acme-api', branch: 'hp/acme-api/t-0013-flaky-export' },
    { id: 'w4', label: 'acme-web', number: 4, status: null, worktree: false, repo: WEB, repoName: 'acme-web', branch: 'main' },
    { id: 'w5', label: 'acme-web', number: 5, status: null, worktree: false },
    { id: 'w6', label: 'acme-shop', number: 6, status: null, worktree: false, session: 'studio' },
  ]
}

const oneTab = (ws: string, tab: string, pane: string, label = '1'): Tab => ({
  id: `${ws}:${tab}`, workspace: ws, label, number: Number(tab.slice(1)) || 1,
  layout: { tab: `${ws}:${tab}`, workspace: ws, zoomed: false, focused: pane, area: { x: 0, y: 0, width: 160, height: 48 }, panes: [{ pane, rect: { x: 0, y: 0, width: 160, height: 48 } }], splits: [] },
})
const one = (ws: string, pane: string): Tab => oneTab(ws, 't1', pane)

export function tabs(): Tab[] {
  return [
    one('w0', ALFRED), one('w1', COORD), one('w5', WEB_COORD), one('w2', CODEX), one('w3', OMP),
    { ...oneTab('w6', 't1', STUDIO_PRODUCER, 'producer'), session: 'studio' }, { ...oneTab('w6', 't2', STUDIO_ACTOR, 'actor-b t2'), session: 'studio' },
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
    pane({ id: ALFRED, workspace: 'w0', agent: 'claude', cwd: `${HOME}/.wherdr/alfred`, status: 'idle', model: MODELS.claude, stateSeq: 3, bornAt: now - 5400_000, coreAddress: 'demo/alfred', preview: 'Two things wait for you in Tasks to review.' }),
    pane({ id: COORD, workspace: 'w1', agent: 'claude', cwd: `${HOME}/.wherdr/coordinators/API`, status: 'idle', model: MODELS.claude, stateSeq: 4, bornAt: now - 3600_000, coreAddress: 'demo/coord-api', preview: 'API-12 and API-13 are under way. I will tell you when one is ready to review.' }),
    pane({ id: WEB_COORD, workspace: 'w5', agent: 'claude', cwd: `${HOME}/.wherdr/coordinators/WEB`, status: 'idle', model: MODELS.claude, stateSeq: 5, bornAt: now - 3000_000, coreAddress: 'demo/coord-web', preview: 'WEB-7 is reviewed: look at its screenshots, then merge.' }),
    pane({ id: CODEX, workspace: 'w2', agent: 'codex', cwd: `${WT}/API-12`, status: 'working', model: MODELS.codex, stateSeq: 7, bornAt: now - 1800_000, coreAddress: 'demo/codex', task: 'API-12', role: 'worker', since: now - 8 * 60_000 }),
    pane({ id: OMP, workspace: 'w3', agent: 'omp', cwd: `${WT}/API-13`, status: 'blocked', model: MODELS.omp, stateSeq: 9, bornAt: now - 1500_000, coreAddress: 'demo/omp', task: 'API-13', role: 'worker', since: now - 2 * 60_000, prompt: approval('npm test -- export.spec.ts --repeat 20') }),
    pane({ id: CLAUDE_WEB, workspace: 'w4', agent: 'claude', cwd: WEB, status: 'done', model: MODELS.claude, stateSeq: 8, bornAt: now - 2400_000, coreAddress: 'demo/claude-web', task: 'WEB-7', role: 'worker' }),
    pane({ id: DEV_SERVER, workspace: 'w4', agent: null, cwd: WEB, command: 'npm run dev', status: null, agentSession: null }),
    pane({
      id: STUDIO_PRODUCER, workspace: 'w6', session: 'studio', agent: 'claude', cwd: `${HOME}/code/acme-shop`, status: 'working', model: MODELS.claude, stateSeq: 6, bornAt: now - 1200_000,
      coreAddress: 'demo/studio-producer', name: 'bl-acme-shop-producer', backlotRole: 'producer', backlotStudio: 'acme-shop', preview: 'Drafting the launch plan',
      labels: { 'backlot.studio': 'acme-shop', 'backlot.role': 'producer', 'herdr.tab': 'producer' },
    }),
    pane({
      id: STUDIO_ACTOR, workspace: 'w6', tab: 'w6:t2', session: 'studio', agent: 'claude', cwd: `${HOME}/code/acme-shop`, status: 'blocked', model: MODELS.claude, stateSeq: 9, bornAt: now - 900_000,
      coreAddress: 'demo/studio-actor', name: 'bl-acme-shop-t2', backlotRole: 'actor-t2-c1', backlotStudio: 'acme-shop', prompt: approval('git status'),
      labels: { 'backlot.studio': 'acme-shop', 'backlot.role': 'actor-t2-c1', 'herdr.tab': 'actor-b t2' },
    }),
  ]
}

// The task agents' rows (GET /api/pm/agents): Codex on its task (by address),
// omp fixing red CI (by its task and role labels, as after a restart).
export const taskAgents = (): Record<string, TaskAgent> => ({
  'demo/codex': { task: 'API-12', shown: 'API-12', title: 'Per-key rate limits on the public API', role: 'dev' },
  'API-13#worker': { task: 'API-13', shown: 'API-13', title: 'Fix the flaky CSV export test', role: 'dev' },
  'demo/claude-web': { task: 'WEB-7', shown: 'WEB-7', title: 'Dark mode toggle on the settings page', role: 'dev' },
})

// The notes the agents wrote (GET /api/notes, NotesPanel.vue).
export const notes = (now: number) => [
  { id: 'this-week', title: 'This week', scope: 'all', body: '- [x] Rate limits merged [[API-12]]\n- [ ] Look at the flaky export fix [[API-13]]\n- [ ] Release notes for 1.4', created: '', updated: new Date(now - 600_000).toISOString() },
  { id: 'billing-page', title: 'Billing page redesign', scope: 'all', body: '[[Waiting|clock|amber]] on the new prices from sales.\nThe [plan](plans/billing.md) has the open questions.', created: '', updated: new Date(now - 3600_000).toISOString() },
  { id: 'reminders', title: 'Reminders', scope: 'all', body: '[[Friday|calendar|blue]] demo to the team, see [this week](this-week.md)\n[[Idea|lightbulb|violet]] cache the CSV export, [sketch](plans/csv-cache.md)', created: '', updated: new Date(now - 7200_000).toISOString() },
]

// The files the notes link to (GET /api/notes/file).
export const noteFiles: Record<string, string> = {
  'plans/billing.md': `# Billing page redesign

The pricing page moves to three plans and yearly billing. Sales confirms the prices by Friday.

## Open questions

- [x] Keep the free plan? Yes, with one project.
- [ ] Show prices with or without tax by default?
- [ ] Discount for yearly billing: 15 % or two months free?
- [ ] Where does the plan comparison table go on a phone?

## Steps

1. Price table component, with the plans from the API.
2. Checkout: the yearly switch, then the summary.
3. Emails: receipt and renewal reminder, see [the email notes](emails.md).

## Out of scope

Invoices in other currencies wait for the next quarter. The current team list stays as it is: see [this week](../this-week.md).
`,
  'plans/emails.md': '# Billing emails\n\n- Receipt right after payment.\n- Renewal reminder 7 days before.\n\nBack to [the plan](billing.md).\n',
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
    [ALFRED]: [
      { role: 'user', text: 'Morning! What needs me today?', ts: at(8) },
      { role: 'tool', name: 'Bash', text: 'wherdr pm board --your-turn', ts: at(8) },
      { role: 'assistant', text: 'Good morning. Two things wait for you in **Tasks to review**:\n\n1. **WEB-7 — Dark mode toggle**: reviewed with no findings. Look at its three screenshots, then merge.\n2. **WEB-8 — Price table**: its agent asks which yearly discount to show.\n\nOn acme-api, Ada has two agents at work (rate limits, the flaky export test) and the webhook retries are in review.', ts: at(7) },
      { role: 'user', text: 'Remind me to write the 2.3 release notes on Friday.', ts: at(6) },
      { role: 'tool', name: 'Edit', text: 'notes/reminders.md', ts: at(6) },
      { role: 'assistant', text: 'Added to your **Reminders** note: release notes for 2.3, Friday.', ts: at(5) },
    ],
    [WEB_COORD]: [
      { role: 'user', text: 'Add a dark mode toggle to the settings page, and start on the price table from the billing plan.', ts: at(96) },
      { role: 'tool', name: 'Bash', text: 'wherdr pm task add "Dark mode toggle on the settings page" --type visual --start', ts: at(95) },
      { role: 'tool', name: 'Bash', text: 'wherdr pm task add "Price table on the billing page" --type visual --start', ts: at(36) },
      { role: 'assistant', text: 'Both are on the board: **WEB-7** (dark mode) is reviewed and waits for your merge; **WEB-8** (price table) has a question for you about the yearly discount.', ts: at(4) },
    ],
    [COORD]: [
      { role: 'user', text: 'Plan the 2.3 release: per-key rate limits on the public API, and the CSV export test that fails one run in ten.', ts: at(62) },
      { role: 'tool', name: 'Bash', text: 'wherdr pm board', ts: at(61) },
      { role: 'tool', name: 'Grep', text: 'rateLimit · src/', ts: at(61) },
      { role: 'assistant', text: 'Two independent pieces of work, touching different files, so they can run in parallel:\n\n1. **API-12 — Rate limits** (Codex): a token bucket per API key in `src/middleware/rateLimit.ts`, `429` with `Retry-After`, limits read from the plan.\n2. **API-13 — Flaky export test** (omp): `export.spec.ts` depends on the order of rows coming back from the database.\n\nI added both tasks and put an agent on each.', ts: at(60) },
      { role: 'tool', name: 'Bash', text: 'wherdr pm task add "Per-key rate limits on the public API" --start', ts: at(59) },
      { role: 'tool', name: 'Bash', text: 'wherdr pm task add "Fix the flaky CSV export test" --start', ts: at(59) },
      { role: 'assistant', text: 'Both agents are on it. Their work is reviewed when they finish, then waits for your approval in Tasks to review.', ts: at(58) },
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

// Backlot studios for the demo's `studio` hc session, including one invented
// studio waiting on an opening design decision.
export function backlotMachines(now: number): BacklotMachineView[] {
  return [{
    session: STUDIO_SESSION,
    machine: '',
    label: 'demo',
    stageRunning: true,
    backlotVersion: '0.4.20',
    summary: {
      schema: 'backlot/1',
      updated_ms: now - 5000,
      backlot_version: '0.4.20',
      studios: [
        {
          id: 'acme-pay',
          title: 'Acme Pay',
          state: 'live',
          requirement_version: 1,
          open_reviews: 0,
          waiting: 0,
          next: 'design sign-off — user',
          repo: `${HOME}/code/acme-pay`,
          tasks_done: 0,
          tasks_total: 0,
          tasks: [],
          roles: [
            { role: 'producer', name: 'producer', state: 'live', work: 'waiting', doing: 'Waiting on opening design sign-off' },
            { role: 'director', name: 'director', state: 'live', work: 'waiting' },
            { role: 'writer', name: 'writer', state: 'live', work: 'waiting' },
          ],
          needs_upgrade: false,
          unknown_kinds: [],
          design: {
            version: 1,
            round: 1,
            phase: 'waiting_user',
            waiting_user: true,
            suggest_skip: false,
            skip_reason: null,
            doc_file: 'design/v1.md',
            summary: 'Split-tender checkout with idempotent payment intents and webhook retries.',
            questions: [
              { id: 'Q1', prompt: 'Persist partial authorizations in SQLite or Postgres?', recommendation: 'Postgres row locks with an idempotency key', section_ref: '§R1.W' },
              { id: 'Q2', prompt: 'Auto-refund remaining capture on webhook timeout?', recommendation: 'Enqueue a compensating refund after 30s', section_ref: '§R1.D' },
            ],
            waiting_since_ms: now - 300_000,
          },
        },
        {
          id: 'acme-shop',
          title: 'Acme shop',
          state: 'live',
          requirement_version: 2,
          open_reviews: 1,
          waiting: 1,
          next: 'Review t2 delivery — director',
          repo: `${HOME}/code/acme-shop`,
          tasks_done: 1,
          tasks_total: 2,
          tasks: [
            { id: 't1', title: 'Catalog filters', status: 'accepted', priority: 'normal', requirement_version: 2, rework_rounds: 0, rework_cap: 3 },
            { id: 't2', title: 'Checkout banner', status: 'running', priority: 'high', requirement_version: 2, rework_rounds: 0, rework_cap: 3, actor_role: 'actor-t2-c1', actor_name: 'alice' },
          ],
          roles: [
            { role: 'producer', name: 'producer', terminal: 'demo/studio-producer', state: 'live', work: 'working', doing: 'Drafting the launch plan' },
            { role: 'actor-t2-c1', name: 'alice', terminal: 'demo/studio-actor', state: 'live', work: 'blocked', task: 't2', attention: 'permission prompt', attention_user: true, attention_seq: 9, attention_detail: 'git status' },
          ],
          needs_upgrade: false,
          unknown_kinds: [],
          design: {
            version: 2,
            round: 1,
            phase: 'signed',
            waiting_user: false,
            suggest_skip: false,
            doc_file: 'design/v2-final.md',
            questions: [],
          },
        },
      ],
      hollywood: null,
    },
  }]
}

export function backlotDesignDocs(): Record<string, string> {
  return {
    'acme-pay:design/v1.md': `# Design discussion · req v1: Split-tender checkout

## R1

### §R1.W Proposal · writer (#2)

Introduce an explicit \`payment_intent_splits\` table keyed by \`idempotency_key\` so card and store-credit legs settle atomically.

### §R1.D Buildability · director (#3)

Build fits into two tasks: ledger migration first, then checkout webhook compensator with 30s timeout handling.

### §R1.P Summary · producer (#4)

Split-tender checkout with idempotent payment intents and webhook retries.

#### Questions

- **Q1**: Persist partial authorizations in SQLite or Postgres? *(recommendation: Postgres row locks with an idempotency key, ref: §R1.W)*
- **Q2**: Auto-refund remaining capture on webhook timeout? *(recommendation: Enqueue a compensating refund after 30s, ref: §R1.D)*
`,
    'acme-shop:design/v2-final.md': `# Design discussion · req v2: Seasonal launch banner

## R1

### §R1.W Proposal · writer (#1)

Render the seasonal promo banner above checkout totals.

## Sign-off (#4)

- Signer: user
- Mode: approved
- Round: r1
`,
  }
}
