import { expect, it } from 'vitest'
import { agentRole, taskAgents } from '../shared/pm/taskAgents'
import { planSteps } from '../shared/pm/steps'
import { company } from '../shared/pm/examples'
import { groupTaskAgents, stateDuration, taskAgentTitle } from '../app/utils/taskAgentRow'
import type { Run, Task } from '../shared/pm/run'

// company's feature: todo, work (worker), review (reviewer), pr (worker), merge, deploy, done.
const plan = planSteps(company, { type: 'feature' })
const at = (n: number, extra: object = {}) => ({ at: n, started: true, since: 100, rounds: {}, proofs: {}, ...extra })
const task = (step: object, log: Task['log'] = []): Task => ({ id: 'CO-1', project: 'CO', title: 'Fix the login', description: '', type: 'feature', state: 'working', createdAt: 1, step: step as Task['step'], log })
const worker = { role: 'worker' } as const, reviewer = { role: 'reviewer' } as const

it('the role says what the agent does in its task', () => {
  expect(agentRole(task(at(1)), plan, worker)).toEqual({ role: 'dev' })
  expect(agentRole(task(at(2)), plan, reviewer)).toEqual({ role: 'review' })
  // Back on the work step after the review, or a failed action / the user's note.
  expect(agentRole(task(at(1, { backFrom: 'review' })), plan, worker)).toEqual({ role: 'fix' })
  expect(agentRole(task(at(1, { fix: 'Tests fail. Fix it' })), plan, worker)).toEqual({ role: 'fix' })
  // During the merge step, the engine's latest send to the worker: red CI, then the base merge.
  const sent = (text: string, at = 200) => ({ at, by: 'engine', text })
  expect(agentRole(task(at(4), [sent('ci-to-agent: sent to the agent')]), plan, worker)).toEqual({ role: 'fix' })
  expect(agentRole(task(at(4), [sent('ci-to-agent: sent to the agent'), sent('catch-up: sent to the agent', 300)]), plan, worker)).toEqual({ role: 'catch-up' })
  // A catch-up the engine made alone, or a send before the step began, says nothing.
  expect(agentRole(task(at(4), [sent('catch-up: caught up with main'), sent('ci-to-agent: sent to the agent', 50)]), plan, worker)).toEqual({ role: 'dev' })
  // The reviewer kept between rounds: in reserve, still 'review'.
  expect(agentRole(task(at(1, { backFrom: 'review' })), plan, reviewer)).toEqual({ role: 'review', reserve: true })
})

it('running agents are listed by address, and each role a task ran by its labels, with the shown key', () => {
  const run = (id: string, extra: Partial<Run>): Run => ({ id, task: 'CO-1', role: 'worker', program: 'claude', model: 'm', machine: '', worktree: '~/project', branch: 'b', instructions: 'i', attempt: 1, state: 'running', startedAt: 1, ...extra })
  const runs = [run('a', { terminal: 't1' }), run('b', { terminal: 't2', state: 'ended' }), run('c', {}), run('d', { terminal: 't3', task: 'CO-9' })]
  const dev = { task: 'CO-1', shown: 'AC-1', title: 'Fix the login', role: 'dev' }
  expect(taskAgents([task(at(1))], runs, () => plan, id => id.replace('CO', 'AC'))).toEqual({ 't1': dev, 'CO-1#worker': dev })
  // Its run ended (resumed under a new one, lost at a restart): its labels still name it.
  expect(taskAgents([task(at(2))], [run('e', { role: 'reviewer', state: 'ended', terminal: 't4' })], () => plan, id => id)).toEqual({ 'CO-1#reviewer': { ...dev, shown: 'CO-1', role: 'review' } })
  // A done task whose agents ended: none.
  expect(taskAgents([task(at(6, { done: true }))], [run('f', { state: 'ended' })], () => plan, id => id)).toEqual({})
})

it('a task agent is titled after its task unless the user renamed it', () => {
  const agent = { task: 'CO-1', shown: 'AC-1', title: 'Fix the login', role: 'dev' } as const
  expect(taskAgentTitle({ label: null }, agent)).toBe('AC-1 Fix the login')
  expect(taskAgentTitle({ label: 'Mine' }, agent)).toBe('')
  expect(taskAgentTitle({ label: null })).toBe('')
  const long = taskAgentTitle({ label: null }, { ...agent, title: 'x'.repeat(80) })
  expect(long).toHaveLength(60)
  expect(long.endsWith('…')).toBe(true)
})

it('the duration reads in minutes, hours, then days', () => {
  const min = 60_000
  expect(stateDuration(undefined, 0)).toBe('')
  expect(stateDuration(1000, 0)).toBe('')
  expect(stateDuration(0, 10_000)).toBe('1 min')
  expect(stateDuration(0, 8 * min)).toBe('8 min')
  expect(stateDuration(0, 125 * min)).toBe('2 h')
  expect(stateDuration(0, 50 * 60 * min)).toBe('2 d')
})

it('agents of the same task make one row, led by the most urgent, where the first one was', () => {
  const rows = [
    { id: 'a', task: 'CO-1', u: 2 }, { id: 'b' }, { id: 'c', task: 'CO-2', u: 2 },
    { id: 'd', task: 'CO-1', u: 1 }, { id: 'e', task: 'CO-1', u: 1 },
  ] as { id: string, task?: string, u?: number }[]
  const groups = groupTaskAgents(rows, r => r.task, r => r.u ?? 9)
  expect(groups.map(g => [g.lead.id, g.agents.map(r => r.id)])).toEqual([
    ['d', ['a', 'd', 'e']], ['b', ['b']], ['c', ['c']],
  ])
})
