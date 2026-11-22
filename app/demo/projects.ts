// Projects of the browser demo (wherdr.dev/demo): two invented projects, their
// coordinators, Alfred, and tasks in every column of the board. Pure fiction,
// in English, with no real path, machine, person or conversation. The board is
// drawn from these tasks by the app's own code (pm.ts).
import type { Project } from '../../shared/pm/project'
import type { Run, Task } from '../../shared/pm/run'
import type { StepState } from '../../shared/pm/steps'
import type { Shot } from '../../shared/pm/shots'
import { wherdr as standard } from '../../shared/pm/examples'
import type { Template } from '../../shared/pm/workflow'
import { HOME } from './scenario'

// wherdr's own example workflow, its pull requests aimed at main.
export const TEMPLATE: Template = { ...standard, id: 'standard', steps: { ...standard.steps, pr: { id: 'pr', column: 'Review', ends: 'action', action: { kind: 'github.pr', base: 'main' } } } }
// herdr-core addresses of the demo's coordinator and task agents (Pane.coreAddress).
export const ALFRED_AT = 'demo/alfred'
export const API_COORD_AT = 'demo/coord-api'
export const WEB_COORD_AT = 'demo/coord-web'
export const CODEX_AT = 'demo/codex'
export const OMP_AT = 'demo/omp'
export const WEB_AT = 'demo/claude-web'

export const projects = (): Project[] => [
  { key: 'API', name: 'acme-api', coordinatorName: 'Ada', color: 'blue', machine: '', path: `${HOME}/code/acme-api`, base: 'main', from: { template: 'standard', version: 1 }, addedAt: 0 },
  { key: 'WEB', name: 'acme-web', coordinatorName: 'Grace', color: 'violet', machine: '', path: `${HOME}/code/acme-web`, base: 'main', from: { template: 'standard', version: 1 }, addedAt: 0 },
]

// Made-up screenshots, in app/demo/public/shots (the demo's own static files).
export const SHOTS = ['a1d4c0de0001.png', 'a1d4c0de0002.png', 'a1d4c0de0003.png']

export function tasks(now: number): Task[] {
  const min = (n: number) => now - n * 60_000
  const at = (i: number, since: number, more: Partial<StepState> = {}): StepState => ({ at: i, started: true, since, proofs: {}, rounds: {}, ...more })
  const shots: Shot[] = SHOTS.map((file, i) => ({ file, phase: 'after', at: min(30 - i) }))
  const task = (id: string, type: string, title: string, description: string, more: Partial<Task> = {}): Task =>
    ({ id, project: id.split('-')[0]!, type, title, description, state: 'working', createdAt: min(100), ...more })
  return [
    task('WEB-7', 'visual', 'Dark mode toggle on the settings page', 'Add an Appearance row to Settings: System, Light, Dark. Follow the system by default, remember the choice, no flash on reload.', {
      step: at(4, min(12), {
        yourTurn: { reason: 'user', badge: 'Look at the screenshots, then merge' },
        shots: { work: shots },
        proofs: { pr: { link: 'https://example.com/acme/acme-web/pull/41' } },
      }),
      branch: 'task/WEB-7', tags: ['ui'],
      tldr: { key: 'demo', at: min(12), text: 'Settings has a new **Appearance** row: System (default), Light, Dark.\n\n- The choice is saved and applied before the first paint: no flash on reload.\n- Reviewed: no findings. Tests pass (48/48).\n\nLook at the three screenshots, then **Merge**.' },
      log: [
        { at: min(95), by: 'Grace', text: 'Created from the request "dark mode on the settings page"' },
        { at: min(94), by: 'engine', text: 'Started: claude on task/WEB-7' },
        { at: min(40), by: 'worker', text: 'Reported: Appearance row, useColorMode composable, 3 screenshots' },
        { at: min(38), by: 'engine', text: 'Opened PR #41' },
        { at: min(13), by: 'reviewer', text: 'Verdict: no findings' },
      ],
    }),
    task('WEB-8', 'visual', 'Price table on the billing page', 'Three plans side by side, monthly and yearly prices, the current plan marked.', {
      state: 'waiting', waitKind: 'question', waiting: 'Asks a question',
      question: 'The yearly discount is not in the spec. How should the yearly prices show?\n\n```wherdr\nchoices "15 % off" | "Two months free" | "Monthly price only"\n```',
      questionTldr: { key: 'demo', at: min(4), text: 'Which yearly discount should the price table show?' },
      step: at(1, min(35)),
      log: [{ at: min(36), by: 'Grace', text: 'Created from the plan "Billing page redesign"' }, { at: min(35), by: 'engine', text: 'Started: claude on task/WEB-8' }],
    }),
    task('WEB-9', 'visual', 'Empty states for the dashboard', 'Each dashboard card says what to do when it has no data yet.', { state: 'todo', after: 'WEB-7' }),
    task('WEB-6', 'simple', 'Mobile menu covers the page title', 'On a phone the open menu hides the title: push the page down instead.', {
      state: 'working', step: at(5, min(300), { done: true }), log: [{ at: min(300), by: 'engine', text: 'Merged PR #39' }],
    }),
    task('API-12', 'simple', 'Per-key rate limits on the public API', 'A token bucket per API key, 429 with Retry-After, limits from the customer plan. Tests included.', {
      step: at(1, min(30)), branch: 'task/API-12', log: [{ at: min(31), by: 'Ada', text: 'Created for the 2.3 release' }],
    }),
    task('API-13', 'simple', 'Fix the flaky CSV export test', 'export.spec.ts fails about one run in ten in CI. Find out why and make it deterministic.', {
      step: at(1, min(25)), branch: 'task/API-13', tags: ['ci'], log: [{ at: min(25), by: 'user', text: 'started the task' }],
    }),
    task('API-10', 'simple', 'Webhook retries with backoff', 'Retry failed webhook deliveries 5 times, doubling the wait, then mark them failed.', {
      step: at(3, min(6)), branch: 'task/API-10',
    }),
    task('API-14', 'study', 'Compare Postgres full-text search with a search service', 'Report only: what each costs, how fast, what changes in the code.', { state: 'todo' }),
    task('API-9', 'simple', 'Cursor pagination on /invoices', 'Replace page numbers with an opaque cursor.', {
      step: at(5, min(26 * 60), { done: true }), log: [{ at: min(26 * 60), by: 'engine', text: 'Merged PR #118' }],
    }),
  ]
}

export const runs = (now: number): Run[] => {
  const run = (task: string, role: Run['role'], program: string, terminal: string, ago: number): Run =>
    ({ id: `r-${task}-${role}`, task, role, program, model: '', machine: '', worktree: `${HOME}/.wherdr/worktrees/${task}`, branch: `task/${task}`, instructions: '', terminal, attempt: 1, state: 'running', startedAt: now - ago * 60_000 })
  return [run('WEB-7', 'worker', 'claude', WEB_AT, 95), run('API-12', 'worker', 'codex', CODEX_AT, 30), { ...run('API-13', 'worker', 'omp', OMP_AT, 25), agent: 'omp-sub' }] // omp-sub: a named agent (Settings › Agents)
}
