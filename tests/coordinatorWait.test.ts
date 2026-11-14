import { expect, it } from 'vitest'
import { ASKED_COORDINATOR, coordinatorWait, type Card } from '../shared/pm/board'
import type { StepState } from '../shared/pm/steps'

const plan = [{ id: 'work', holder: 'worker' as const, ends: 'report' as const, timeout: '3h' }, { id: 'deploy', holder: 'coordinator' as const, ends: 'report' as const, recheck: '5m', timeout: '90m' }]
const at = (i: number, more: Partial<StepState> = {}): StepState => ({ at: i, started: true, since: 100, proofs: {}, rounds: {}, ...more })
const card = (state: StepState, more: Partial<Card> = {}): Card => ({
  id: 'CO-1', shown: 'CO-1', project: 'CO', title: 'Ship it', description: '', column: 'Deploy', phase: 'working', holder: state.at ? 'coordinator' : 'worker',
  tags: [], links: [], log: [], plan, state, ...more,
})
const over = { reason: 'timeout' as const, badge: 'Check deploy: over 90m' }

it('says what waits only for a coordinator-held step past its limit or waiting until the user', () => {
  const late = card(at(1, { yourTurn: over }), { yourTurn: over.badge })
  expect(coordinatorWait(late)).toEqual({ step: 'deploy', since: 100 })
  // Waiting until the user, with the coordinator's last `step wait` reason (an older step's is not this one's).
  const log = [{ at: 50, by: 'coordinator CO', text: 'deploy: next recheck in 1h. Old.' }, { at: 200, by: 'coordinator CO', text: 'deploy: next recheck when the user writes or acts on the task. The pipeline is red. Needs a token.' }]
  expect(coordinatorWait(card(at(1, { waitUser: 200 }), { log }))).toEqual({ step: 'deploy', since: 100, reason: 'The pipeline is red. Needs a token.' })
  // Not on a coordinator step at work, nor a worker's step over its limit, nor once stopped.
  expect(coordinatorWait(card(at(1)))).toBeUndefined()
  expect(coordinatorWait(card(at(0, { yourTurn: over }), { yourTurn: over.badge }))).toBeUndefined()
  expect(coordinatorWait(card(at(1, { waitUser: 200 }), { stopped: { by: 'the user', why: 'x', at: 300 } }))).toBeUndefined()
})

it('once asked, the button says Asked until a new time limit or wait comes', () => {
  const asked = [{ at: 300, by: 'user', text: `${ASKED_COORDINATOR}deploy step` }]
  expect(coordinatorWait(card(at(1), { log: asked }))).toMatchObject({ asked: 300 })
  expect(coordinatorWait(card(at(1, { yourTurn: over }), { log: asked }))?.asked).toBeUndefined()
  expect(coordinatorWait(card(at(1, { waitUser: 400 }), { log: asked }))?.asked).toBeUndefined()
  // An ask at an earlier run of the step does not count.
  expect(coordinatorWait(card(at(1, { since: 500 }), { log: asked }))).toBeUndefined()
})
