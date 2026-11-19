// A project coordinator's default agent: the user's first offered Claude or Codex, never omp unless it is
// the user's explicit choice or all that is offered. Alfred keeps the user's order.
import { afterEach, expect, it } from 'vitest'
import { coordinatorAgent, defaultProjectChoice, offerCoordinators } from '~/composables/useAgentList'
import { agentOrder, appConfig, hiddenAgents } from '~/composables/useHerdr'
import { MAIN } from '#shared/pm/coordinator'

const kinds = appConfig.value.kinds
afterEach(() => { hiddenAgents.value = []; agentOrder.value = []; appConfig.value = { ...appConfig.value, kinds } })
const offer = (kinds: string[], order: string[] = [], hidden: string[] = []) => {
  appConfig.value = { ...appConfig.value, kinds }
  agentOrder.value = order
  hiddenAgents.value = hidden
}

it('omp first in the user\'s order: a new project coordinator still defaults to Claude, and omp is offered', () => {
  offer(['claude', 'codex', 'omp'], ['omp', 'codex', 'claude'])
  expect(offerCoordinators(undefined, 'WEB')).toEqual(['omp', 'codex', 'claude'])
  expect(coordinatorAgent({ project: 'WEB' })).toEqual({ program: 'codex' })
  expect(defaultProjectChoice(offerCoordinators(undefined, 'WEB'))).toBe('codex')
  offer(['claude', 'codex', 'omp'], ['omp', 'claude'], ['codex'])
  expect(coordinatorAgent({ project: 'WEB' })).toEqual({ program: 'claude' })
})

it('an explicit omp is kept while it is offered; hidden, the default moves to Claude or Codex', () => {
  offer(['claude', 'omp'], ['omp'])
  expect(coordinatorAgent({ project: 'WEB', agent: { program: 'omp' } })).toEqual({ program: 'omp' })
  offer(['claude', 'omp'], ['omp'], ['omp'])
  expect(coordinatorAgent({ project: 'WEB', agent: { program: 'omp' } })).toEqual({ program: 'claude' })
})

it('Alfred is unchanged: the user\'s chosen agent, else their first offered', () => {
  offer(['claude', 'omp'], ['omp'])
  expect(coordinatorAgent({ project: MAIN, agent: { program: 'claude' } })).toEqual({ program: 'claude' })
  expect(coordinatorAgent({ project: MAIN })).toEqual({ program: 'omp' })
})
