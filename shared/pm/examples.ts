// Example templates, to copy and change. None applies by default; wherdr
// imposes no workflow. Tool names appear only as text given to agents.
import type { Template } from './workflow'

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

export const EXAMPLES = [vibe, company, github, common]
