// "Check on GitHub": wherdr reads a task's PR now, for a task stuck at its
// merge step or archived with a PR. Pure: which tasks offer it, what is said
// of an open PR, and an archived task whose PR was merged. The server reads the
// PR and moves the task (server/utils/pmGhCheck.ts).
import { prNow } from './board'
import { mayMerge, type ResolvedGuards } from './guards'
import type { PlannedStep, StepState } from './steps'
import type { Check } from './actions'

export const PR_VIEW_FIELDS = 'url,state,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup,reviewDecision'
export interface PrView {
  url: string, state: 'OPEN' | 'MERGED' | 'CLOSED', baseRefName: string, headRefOid: string
  mergeStateStatus?: string, statusCheckRollup?: Check[], reviewDecision?: string
}
// What the check found, said to the user; archive: offered for a PR closed without a merge.
export interface GhCheck { outcome: 'merged' | 'open' | 'closed', url: string, text: string, archive?: true }

const MERGES = ['github.merge', 'git.verify-merged']

// The task's PR: the link its PR step recorded.
export const taskPr = (plan: PlannedStep[], s: StepState | undefined) =>
  plan.filter(p => p.action?.kind === 'github.pr').map(p => s?.proofs[p.id]?.link).findLast(l => !!l)

// Offered for a task with a PR at a github.merge step, or archived.
export function checkable(plan: PlannedStep[], s: StepState | undefined): boolean {
  if (!s?.started || !taskPr(plan, s)) return false
  return s.done ? !!s.abandoned : plan[s.at]?.action?.kind === 'github.merge'
}
// The button, on a card: not on a stopped task (continue it first).
export const canCheckGithub = (c: { plan: PlannedStep[], state?: StepState, stopped?: unknown }) => !c.stopped && checkable(c.plan, c.state)

const REVIEW: Record<string, string> = { REVIEW_REQUIRED: 'a review is required', CHANGES_REQUESTED: 'changes were requested' }

// Why an open PR is not merged yet: its checks and state, its review, the guard.
export function openWhy(pr: PrView, required: string[], g: ResolvedGuards, step: PlannedStep | undefined): string {
  const why = [prNow(pr, required)!, REVIEW[pr.reviewDecision ?? '']]
  if (step?.guarded || !mayMerge(g, pr.baseRefName, 'engine')) why.push(`only you may merge into ${pr.baseRefName}`)
  return `The PR is open: ${why.filter(Boolean).join('; ')}`
}

// An archived task whose PR was merged on GitHub: done as merged, the PR
// recorded on its merge step (the card then says merged). Unchanged without one.
export function mergedArchive(plan: PlannedStep[], s: StepState, url: string): StepState {
  const m = plan.findLast(p => p.action && MERGES.includes(p.action.kind))
  return m ? { ...s, abandoned: undefined, proofs: { ...s.proofs, [m.id]: { ...s.proofs[m.id], link: url } } } : s
}
