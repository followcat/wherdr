// An outside contributor's PR merged by the project coordinator, after the
// user's yes in the conversation, when the project's contributorPrs guard is
// on. A board task's PR stays the engine's. Pure: the server reads the PR and
// merges it (server/utils/pmCoordinator.ts).
import { combineGuards, mayMerge } from './guards'
import { prReady, type PrInfo } from './actions'
import type { Guards } from './workflow'
import type { Turn } from './coordinator'

// `gh pr view <n> --json` with these fields.
export const PR_FIELDS = 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup'
export interface ContributorPr extends PrInfo {
  number: number, state: string, isDraft?: boolean, headRefName: string, mergeable?: string, mergeStateStatus?: string
}
export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const
export type MergeMethod = typeof MERGE_METHODS[number]

// The guard's line in the role text, only when it is on.
export const contributorPrsLine = (g?: Guards) => g?.contributorPrs
  ? `- merge an outside contributor's PR (\`pr merge\`): only after the user's yes in this conversation, with their words; ${g.contributorPrs === 'all' ? 'into any branch' : 'never into a branch reserved for the user'}; never a board task's PR (the engine's)`
  : undefined

// A board task's branch (task/<ID>, or its own: taskLinks has it) or a PR linked on a task's card.
export const isTaskPr = (pr: Pick<ContributorPr, 'headRefName' | 'url'>, taskLinks: string[]) =>
  /^task\/[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(pr.headRefName) || taskLinks.includes(pr.url) || taskLinks.includes(pr.headRefName)

// Why the coordinator may not merge a PR in this turn at all, or undefined:
// checked before GitHub is asked anything.
export function prMergeAskRefusal(c: { guards?: Guards, turn: Turn, userSaid?: string }): string | undefined {
  if (c.turn !== 'user') return 'pr merge is only for a turn that comes from the user, never a wake: recommend it and wait for their yes'
  if (!c.userSaid?.trim()) return 'pr merge needs the user\'s yes: --user-said "<their words>"'
  if (!c.guards?.contributorPrs) return 'The project\'s guards keep merging the user\'s: the guard "Contributor PRs: the coordinator may merge after your yes" is off'
}

// Why the coordinator may not merge this PR now, or undefined.
export function prMergeRefusal(c: { guards?: Guards, turn: Turn, userSaid?: string, pr: ContributorPr | null, taskLinks: string[] }): string | undefined {
  const ask = prMergeAskRefusal(c)
  if (ask || !c.guards) return ask
  const pr = c.pr
  if (!pr) return 'No such PR in the project\'s repository'
  if (pr.state !== 'OPEN') return `PR #${pr.number} is not open (${pr.state.toLowerCase()})`
  if (isTaskPr(pr, c.taskLinks)) return `PR #${pr.number} is a board task's: the engine merges it through the task's steps`
  if (c.guards.contributorPrs !== 'all' && !mayMerge(combineGuards([{ source: 'project', guards: c.guards }]), pr.baseRefName, 'engine'))
    return `${pr.baseRefName} is reserved for the user: only they merge into it`
  if (pr.isDraft) return `PR #${pr.number} is a draft`
  const ready = prReady(pr, pr.headRefOid)
  if (!ready.ok) return `PR #${pr.number}: ${ready.why}`
  if (pr.mergeable !== 'MERGEABLE') return `PR #${pr.number} is not mergeable (${(pr.mergeable ?? 'unknown').toLowerCase()}): conflicts, or GitHub has not checked it yet`
  if (pr.mergeStateStatus === 'BLOCKED') return `PR #${pr.number} is blocked by the branch's rules (a required review or check)`
}
