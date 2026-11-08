// Example templates, to copy and change. None applies by default; wherdr
// imposes no workflow. Tool names appear only as text given to agents.
import type { Step, StepAction, Template } from './workflow'

const todo = { id: 'todo', column: 'To do' }
const done = { id: 'done', column: 'Done' }
const prefs = { agent: 'claude', model: 'sonnet', reviewModel: 'opus' }

// Commits straight to dev: no PR, no review, no CI.
export const vibe: Template = {
  id: 'vibe', prefs,
  guards: { protected: ['main'], merge: { protected: 'user', others: 'engine' } },
  instructions: 'Commit small, clear commits.',
  taskTypes: {
    simple: { steps: [todo,
      { id: 'work', column: 'Working', holder: 'worker', ends: 'report', instructions: 'Run the quick check (npm run lint) before saying done.' },
      { id: 'land', column: 'Working', ends: 'action', action: { kind: 'git.land', target: 'dev' } },
      done] },
  },
}

// A company flow: the PR is made with the user's own tool and merged by hand.
export const company: Template = {
  id: 'company', prefs,
  guards: { protected: ['main', 'master', 'uat', 'develop'], merge: { protected: 'user' } },
  instructions: 'Base branch is develop.',
  taskTypes: {
    feature: { steps: [todo,
      { id: 'work', column: 'Working', holder: 'worker', ends: 'report',
        instructions: 'Lint and typecheck only, push, then follow the CI pipeline and fix what fails.' },
      { id: 'review', column: 'Review', holder: 'reviewer', ends: 'verdict', sendBack: 'work', rounds: 2 },
      { id: 'pr', column: 'Review', holder: 'worker', ends: 'report', evidence: ['link'],
        instructions: 'Create the PR to develop with your PR tool, with the task description as its body.' },
      { id: 'merge', column: 'Review', holder: 'none', ends: 'user', userLabel: 'Merged', badge: 'Merge the PR',
        action: { kind: 'git.verify-merged', target: 'develop' } },
      { id: 'deploy', column: 'Deploy', holder: 'coordinator', ends: 'report', recheck: '5m', timeout: '90m',
        instructions: 'Watch the develop pipeline and the deploy. Deployed: say so and finish. Failed: say which test failed and investigate.' },
      done] },
  },
}

// A GitHub repository: the engine opens the PR and merges after review.
export const github: Template = {
  id: 'github', prefs,
  guards: { protected: ['main', 'develop'], merge: { protected: 'user', others: 'engine' } },
  instructions: 'Code, commits and PR in English.',
  taskTypes: {
    simple: { steps: [todo,
      { id: 'work', column: 'Working', holder: 'worker', ends: 'report', instructions: 'Run the unit tests of what you changed and the typecheck.' },
      { id: 'pr', column: 'Review', ends: 'action', action: { kind: 'github.pr', base: 'next' } },
      { id: 'review', column: 'Review', holder: 'reviewer', ends: 'verdict', sendBack: 'work', rounds: 2 },
      { id: 'merge', column: 'Merging', ends: 'action', action: { kind: 'github.merge' } },
      done] },
  },
}

// Common task types: a study, and a feature split first.
export const common: Template = {
  id: 'common', prefs,
  taskTypes: {
    study: { steps: [todo,
      { id: 'work', column: 'Working', holder: 'worker', ends: 'report', evidence: ['report'],
        instructions: 'Research only: change nothing in the repo, write the report outside it.' },
      done] },
    'feature-split': { steps: [
      { id: 'split', column: 'Working', holder: 'worker', ends: 'report', evidence: ['proposed-tasks'],
        instructions: 'Propose a split into tasks under 400 changed lines, each with its definition of done.' },
      { id: 'pick', column: 'Working', holder: 'none', ends: 'user', userLabel: 'Create these tasks' },
      done] },
  },
}

// How this repository is run: Opus workers and a fresh Opus reviewer, each
// change a PR to v3, squash-merged by the engine once reviewed and `smoke` is
// green. A visual change waits for the user's merge, with screenshots; a
// study gives a report and no PR. main and develop are the user's only.
const toV3: Step = { id: 'pr', column: 'Review', ends: 'action', action: { kind: 'github.pr', base: 'v3' } }
const squash: StepAction = { kind: 'github.merge', method: 'squash', checks: ['smoke'] }
const work = (more = ''): Step => ({ id: 'work', column: 'Working', holder: 'worker', ends: 'report', timeout: '3h',
  instructions: `Test policy: fewer tests, at the cheapest level (unit, then Vitest component, an e2e test only when nothing else can check it), never a duplicate. Run only the tests of what you changed (npx vitest related --run <files>) and npx nuxt typecheck; never a full suite, CI runs them. Keep the change under about 400 lines: past that, stop and propose a split. Before you finish, merge origin/v3 into your branch.${more}` })
export const wherdr: Template = {
  id: 'wherdr',
  prefs: { agent: 'claude', model: 'claude-opus-5-5', reviewModel: 'same' },
  guards: { protected: ['main', 'develop'], merge: { protected: 'user', others: 'engine' } },
  instructions: 'Public repo: code, comments, tests, commits and PR text in English; interface text through t()/tl(). Nothing personal anywhere (home paths, machine names, e-mails, real IDs), screenshots included. Start every claude or codex you launch for a test with DISABLE_AUTOUPDATER=1, and never change ~/.claude, ~/.codex or ~/.local/bin.',
  steps: {
    work: work(),
    pr: toV3,
    review: { id: 'review', column: 'Review', holder: 'reviewer', ends: 'verdict', sendBack: 'work', rounds: 3, timeout: '45m',
      instructions: 'Read the diff and run only the tests that concern it. Severity by impact: major or critical only if it breaks the definition of done, loses or exposes data, opens a security hole or makes a visible feature wrong; the rest is minor or trivial. An e2e test that could be a unit or component test, or a duplicated test, is major.' },
  },
  taskTypes: {
    simple: { steps: [todo, 'work', 'pr', 'review', { id: 'merge', column: 'Merging', ends: 'action', action: squash }, done] },
    visual: { steps: [todo,
      { ...work(' A visual change: follow docs/design.md, and check it at iPhone 13 and 1440x900 sizes.'), evidence: ['screenshots'] },
      'pr', 'review',
      { id: 'merge', column: 'Merging', ends: 'user', userLabel: 'Merge', badge: 'Look at the screenshots, then merge', action: squash },
      done] },
    study: { steps: [todo,
      { id: 'work', column: 'Working', holder: 'worker', ends: 'report', timeout: '3h', evidence: ['report'],
        instructions: 'Research only: change nothing in the repo, open no PR. Your closing note is the report.' },
      done] },
  },
}

export const EXAMPLES = [vibe, company, github, common, wherdr]
