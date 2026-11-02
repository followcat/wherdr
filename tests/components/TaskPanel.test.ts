import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import BoardPanel from '~/components/BoardPanel.vue'
import { allSessionsState, herdrState } from '~/composables/useHerdr'
import { parseTaskDetails, parseTaskRow } from '#shared/projectsTasks'

const decision = vi.hoisted(() => ({ yes: true }))
mockNuxtImport('askConfirm', () => async () => decision.yes)
const toasts = vi.hoisted(() => [] as string[])
mockNuxtImport('toast', () => (msg: string) => { toasts.push(msg) })

let failure: Record<string, unknown> = {}
let pane: string | null = 'w1:p1'
let stage = 'failed'
let msg = ''
// What the server adds from the task's file (failureStale).
let more: Record<string, unknown> = {}
let review: unknown = null
let settingsReads = 0
registerEndpoint('/api/tasks/settings', () => { settingsReads++; return { settings: [], problems: [] } })
const calls: unknown[] = []
registerEndpoint('/api/tasks/details', () => ({ ...parseTaskDetails(JSON.stringify({ task: { id: 'demo/9', title: 'Improve search', stage, msg, description: 'Search by title' }, failure, review, summary: 'Search tested.' })), ...more, pane }))
registerEndpoint('/api/tasks/action', { method: 'POST', handler: async event => { calls.push(await readBody(event)); return { ok: true } } })
registerEndpoint('/api/tasks/tell', { method: 'POST', handler: async event => { calls.push(await readBody(event)); return { ok: true } } })
registerEndpoint('/api/sessions', { method: 'POST', handler: async event => { const body = await readBody(event); calls.push(body); return { session: { name: body.name, key: 'abcdef01', running: true } } } })
registerEndpoint('/api/tasks/approve', { method: 'POST', handler: async event => { calls.push(await readBody(event)); return { ok: true } } })
const row = () => parseTaskRow({ id: 'demo/9', title: 'Improve search', stage, state: 'error', app: 'claude' })!
async function panel(extra = {}, agent: string | null = null, status: 'idle' | 'working' = 'idle') {
  herdrState.value = { ok: true, workspaces: [], panes: [{ id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent, name: null, label: null, status, title: null, cwd: '/tmp/demo', agentSession: null }] }
  const w = await mountSuspended(BoardPanel, { props: { target: { kind: 'task', machine: '', id: 'demo/9' }, task: row(), machineLabel: 'devbox', reachable: true, ...extra }, global: { stubs: { AgentView: { props: ['selectedMode'], template: '<div class="embedded-agent">{{ selectedMode }}</div>' }, TaskSheet: { template: '<div class="task-content">Search by title</div>' } } } })
  await flushPromises()
  return w
}
afterEach(() => { settingsReads = 0; review = null; toasts.length = 0; failure = {}; pane = 'w1:p1'; stage = 'failed'; msg = ''; more = {}; calls.length = 0; decision.yes = true; herdrState.value = { ok: false, workspaces: [], panes: [] }; allSessionsState.value = { ok: false, workspaces: [], panes: [] } })

describe('task panel', () => {
  it('labels the worker conversation and opens the separate reviewer terminal', async () => {
    stage = 'reviewing'
    more = { identity: { agent: 'claude', reviewer: 'codex', from: '' }, reviewer: { pane: 'w1:p4' } }
    const w = await panel({}, 'claude')
    herdrState.value = { ...herdrState.value, panes: [...herdrState.value.panes, { ...herdrState.value.panes[0]!, id: 'w1:p4', agent: 'codex', status: 'working' }] }
    await flushPromises()
    expect(w.find('.board-panel-name > .avatar').classes()).toContain('claude')
    expect(w.find('.task-agent-reviewer .avatar').classes()).toContain('codex')
    expect(w.find('.task-review-context').text()).toContain('Claude’s conversation. The review runs separately.')
    await w.find('.task-review-context button').trigger('click')
    expect(w.find('.embedded-agent').text()).toBe('term')
    w.unmount()
  })
  it('offers the reviewer session during an ongoing review elsewhere', async () => {
    stage = 'reviewing'
    more = { identity: { agent: 'claude', reviewer: 'codex', from: '' }, reviewer: { pane: 'abcdef01~w5:p1' } }
    // Details can move on before the cached Board row does.
    const w = await panel({ task: { ...row(), stage: 'working' } }, 'claude')
    allSessionsState.value = {
      ok: true, workspaces: [],
      panes: [{ ...herdrState.value.panes[0]!, id: 'abcdef01~w5:p1', machine: 'abcdef01', agent: 'codex' }],
      machines: [{ key: 'abcdef01', baseKey: '', session: 'review', label: 'devbox', local: true, status: 'online', error: null }],
    }
    await flushPromises()
    expect(w.find('.task-review-context button').text()).toBe('Switch to the reviewer session')
    expect(w.find('.board-panel-name > .avatar').classes()).toContain('claude')
    w.unmount()
  })
  it('explains setup failure while keeping its shell in Agent', async () => {
    failure = { stage: 'setup', title: 'Setup failed', detail: 'npm ci\nLockfile missing', next: 'Restore the lockfile.', agentCanFix: false }
    const w = await panel()
    expect(w.find('.board-panel-name').text()).toContain('Improve search')
    expect(w.find('.task-needs').text()).toContain('Lockfile missing')
    expect(w.find('.task-needs').text()).toContain('Restore the lockfile.')
    expect(w.find('.embedded-agent').text()).toBe('term')
    expect(w.find('.board-panel-agent-bar button').exists()).toBe(false)
    expect(w.emitted('noAgent')).toBeUndefined()
    const start = w.findAll('.task-needs button').find(b => b.text() === 'Start again')!
    await start.trigger('click'); await flushPromises()
    expect(calls).toContainEqual({ machine: '', id: 'demo/9', action: 'delegate' })
    await w.findAll('.board-panel-tabs button')[1]!.trigger('click')
    expect(w.find('.embedded-agent').text()).toBe('term')
    w.unmount()
  })
  it('uses separate retry and fix commands for an agent failure', async () => {
    failure = { stage: 'agent', title: 'Tests failed', detail: 'npm test exited 1', agentCanFix: true }
    const w = await panel()
    for (const [label, action] of [['Retry', 'retry'], ['Send the error to the agent', 'fix']]) {
      const button = () => w.findAll('.task-needs button').find(b => b.text() === label)!
      await vi.waitFor(() => expect(button().attributes('disabled')).toBeUndefined())
      await button().trigger('click')
      await vi.waitFor(() => expect(calls).toContainEqual({ machine: '', id: 'demo/9', action }))
    }
    w.unmount()
  })
  it('keeps a task with no pane open and puts the description in Task', async () => {
    pane = null
    failure = { stage: 'setup', title: 'Setup failed', detail: 'Install failed' }
    const w = await panel()
    expect(w.emitted('noAgent')).toBeUndefined()
    // Nothing to talk to: straight to Task, the other tabs hidden.
    expect(w.findAll('.board-panel-tabs button').map(b => b.text())).toEqual(['Task', 'Settings'])
    expect(w.find('.task-content').text()).toContain('Search by title')
    expect(w.find('.task-new').exists()).toBe(false)
    expect(w.find('.task-setup').exists()).toBe(false)
    expect(w.find('.task-needs').text()).toContain('Install failed')
    w.unmount()
  })
  it('opens a task never started on Task, then on Conversation once its agent starts', async () => {
    pane = null
    stage = 'todo'
    const todo = { ...row(), stage: 'todo', state: 'idle', app: '', group: 'todo' as const }
    const w = await panel({ task: todo, target: { kind: 'task', machine: '', id: `demo/9-${Math.random()}` } }, 'claude')
    expect(w.findAll('.board-panel-tabs button').map(b => b.text())).toEqual(['Task', 'Settings'])
    expect(w.find('.task-content').exists()).toBe(true)
    expect(w.text()).not.toContain('No agent conversation yet')
    // Its agent starts: Conversation is back and shown.
    pane = 'w1:p1'
    stage = 'working'
    await w.setProps({ task: { ...todo, stage: 'working', state: 'working', app: 'claude', group: 'working' } })
    await vi.waitFor(() => expect(w.findAll('.board-panel-tabs button').map(b => b.text())).toEqual(['Task', 'Agent', 'Settings']))
    expect(w.find('.embedded-agent').text()).toBe('chat')
    w.unmount()
  })
  it('keeps a tab picked by hand while it is offered, also when the panel opens again', async () => {
    stage = 'working'
    const id = `demo/9-${Math.random()}`
    const task = { ...row(), stage: 'working', state: 'working', group: 'working' as const }
    const w = await panel({ task, target: { kind: 'task', machine: '', id } }, 'claude')
    expect(w.find('.embedded-agent').text()).toBe('chat')
    await w.findAll('.board-panel-tabs button')[0]!.trigger('click')
    expect(w.find('.task-content').exists()).toBe(true)
    // Reloaded details keep the choice.
    await w.setProps({ task: { ...task, msg: 'moved on' } })
    await flushPromises()
    await new Promise(r => setTimeout(r, 50))
    expect(w.find('.task-content').exists()).toBe(true)
    w.unmount()
    const again = await panel({ task, target: { kind: 'task', machine: '', id } }, 'claude')
    expect(again.find('.task-content').exists()).toBe(true)
    expect(again.find('.board-panel-tabs button.on').text()).toBe('Task')
    // Terminal picked, then its pane is gone: the choice is dropped.
    await again.findAll('.board-panel-tabs button')[1]!.trigger('click')
    await again.get('.board-panel-agent-bar button').trigger('click')
    expect(again.find('.embedded-agent').text()).toBe('term')
    pane = null
    await again.setProps({ task: { ...task, msg: 'stopped' } })
    await vi.waitFor(() => expect(again.findAll('.board-panel-tabs button').map(b => b.text())).toEqual(['Task', 'Agent', 'Settings']))
    // Its reply field (tell) is the default view again, not the terminal.
    await vi.waitFor(() => expect(again.find('#board-panel-tell').exists()).toBe(true))
    again.unmount()
    pane = 'w1:p1'
    const third = await panel({ task, target: { kind: 'task', machine: '', id } }, 'claude')
    expect(third.find('.embedded-agent').text()).toBe('chat')
    third.unmount()
  })
  it('keeps Conversation for a reply passed on when the agent has no pane', async () => {
    pane = null
    stage = 'working'
    const task = { ...row(), stage: 'working', state: 'working', group: 'working' as const }
    const w = await panel({ task, target: { kind: 'task', machine: '', id: `demo/9-${Math.random()}` } })
    expect(w.findAll('.board-panel-tabs button').map(b => b.text())).toEqual(['Task', 'Agent', 'Settings'])
    expect(w.find('#board-panel-tell').exists()).toBe(true)
    w.unmount()
  })
  it('disables writes while unreachable and never offers fix for authentication', async () => {
    failure = { stage: 'agent', title: 'Needs login', auth: true, agentCanFix: false }
    const w = await panel({ reachable: false })
    expect(w.find('.task-needs').text()).not.toContain('Send the error to the agent')
    expect(w.findAll('.task-needs button').every(b => b.attributes('disabled') !== undefined)).toBe(true)
    expect(calls).toHaveLength(0)
    w.unmount()
  })
  it('requires confirmation before an explicit approval override', async () => {
    stage = 'approval'
    const task = { ...row(), group: 'needs' as const, state: 'blocked', kind: 'permission', review: { pass: false, tally: '1 major', by: 'codex' } }
    const w = await panel({ task })
    const approve = w.findAll('.task-needs button').find(b => b.text() === 'Approve anyway')!
    decision.yes = false
    await approve.trigger('click'); await flushPromises()
    expect(calls).toHaveLength(0)
    decision.yes = true
    await approve.trigger('click'); await flushPromises()
    await vi.waitFor(() => expect(calls).toContainEqual({ machine: '', id: 'demo/9', anyway: true }))
    w.unmount()
  })
  // WHR-85: 1.x asks "merge anyway, or send the review back"; sending back comes first.
  it('sends a failed review back to its agent first, its findings shown', async () => {
    stage = 'approval'
    msg = 'Approve to merge? Review: Fail (1 critical, 3 minor)'
    review = { meets: false, pass: false, findings: [
      { severity: 'minor', subject: 'Label typo' }, { severity: 'critical', subject: 'Token in the log' },
      { severity: 'minor', subject: 'Unused import' }, { severity: 'minor', subject: 'Long line' },
      { severity: 'major', subject: 'Was there before', preexisting: true },
    ] }
    const task = { ...row(), group: 'needs' as const, state: 'blocked', kind: 'permission', msg, review: { pass: false, tally: '1 critical, 3 minor', by: 'codex' } }
    const w = await panel({ task })
    const buttons = () => w.findAll('.task-needs-actions button')
    await vi.waitFor(() => expect(buttons().map(b => b.text())).toContain('Send the review back to the agent'))
    const labels = buttons().map(b => b.text())
    expect(labels.indexOf('Send the review back to the agent')).toBeLessThan(labels.indexOf('Approve anyway'))
    expect(w.find('.task-needs-review').classes().join(' ')).toMatch(/primary/)
    expect(w.find('.task-needs-anyway').classes().join(' ')).not.toMatch(/bg-primary/)
    // Worst first, three at most, the one there before left out.
    expect(w.findAll('.task-needs-findings li').map(li => li.text())).toEqual(['CriticalToken in the log', 'MinorLabel typo', 'MinorUnused import'])
    expect(w.find('.task-needs-findings-more').text()).toBe('+1 more in Task')
    expect(w.find('.task-needs').text()).not.toContain('Was there before')
    await w.find('.task-needs-review').trigger('click')
    await vi.waitFor(() => expect(calls).toContainEqual({ machine: '', id: 'demo/9', action: 'review' }))
    w.unmount()
  })
  it('offers no sending back once the review passed', async () => {
    stage = 'approval'
    review = { meets: true, pass: true, findings: [{ severity: 'minor', subject: 'Label typo' }] }
    const task = { ...row(), group: 'needs' as const, state: 'blocked', kind: 'permission', review: { pass: true, tally: '1 minor', by: 'codex' } }
    const w = await panel({ task })
    expect(w.find('.task-needs-review').exists()).toBe(false)
    expect(w.find('.task-needs-findings').exists()).toBe(false)
    w.unmount()
  })
  // In `reviewneeds`, 1.x `tell` reaches the reviewer (flow/talk.rs), not the worker.
  it('says a reply went to the reviewer while the reviewer waits', async () => {
    pane = null
    stage = 'reviewneeds'
    const task = { ...row(), stage: 'reviewneeds', state: 'blocked', kind: 'question', group: 'needs' as const }
    const w = await panel({ task, target: { kind: 'task', machine: '', id: `demo/9-${Math.random()}` } })
    await w.find('#board-panel-tell').setValue('Yes, go on')
    await w.find('.board-panel-tell').trigger('submit')
    await vi.waitFor(() => expect(toasts).toEqual(['Sent to the reviewer']))
    expect(w.find('.board-panel-tell label').text()).toContain('reviewer')
    w.unmount()
  })
  it('says a reply went to the task’s agent otherwise', async () => {
    pane = null
    stage = 'working'
    const task = { ...row(), stage: 'working', state: 'working', group: 'working' as const }
    const w = await panel({ task, target: { kind: 'task', machine: '', id: `demo/9-${Math.random()}` } })
    await w.find('#board-panel-tell').setValue('Go on')
    await w.find('.board-panel-tell').trigger('submit')
    await vi.waitFor(() => expect(toasts).toEqual(['Sent to the task’s agent']))
    w.unmount()
  })
  it('shows a blocked question in the banner and no banner once done', async () => {
    const task = { ...row(), stage: 'asks', state: 'blocked', kind: 'question', msg: 'Which search fields?', group: 'needs' as const }
    const w = await panel({ task })
    expect(w.find('.task-needs').text()).toContain('Which search fields?')
    await w.setProps({ task: { ...task, stage: 'done', state: 'done', group: 'done' } })
    expect(w.find('.task-needs').exists()).toBe(false)
    w.unmount()
  })

  // WHR-38: a review that failed the day before, then a run stopped at its limit.
  it('shows where the task stands now, not a failure it moved on from', async () => {
    stage = 'stopped'
    msg = 'Stopped at its 2h limit'
    failure = { stage: 'review', title: 'Review failed', detail: 'The reviewer finished without a verdict.', next: 'Finish again for a fresh review.', agentCanFix: true, at: 1 }
    more = { failureStale: true }
    const task = { ...row(), stage, state: 'blocked', msg, group: 'needs' as const }
    const w = await panel({ task })
    const banner = w.find('.task-needs')
    expect(banner.find('h3').text()).toBe('Needs you · Stopped at its 2h limit')
    expect(banner.text()).not.toContain('Review failed')
    expect(banner.text()).not.toContain('without a verdict')
    expect(banner.text()).not.toContain('Finish again for a fresh review')
    // Its buttons would act on the old failure: not offered.
    expect(banner.text()).not.toContain('Send the error to the agent')
    expect(banner.findAll('button').map(b => b.text())).toEqual(expect.arrayContaining(['Continue', 'Raise limit', 'Take as is']))
    // The limit Continue grants once more, read from the board's line.
    expect(banner.find('.task-finish-why').text()).toContain('new allowance (2 h a run)')
    w.unmount()
  })
  // WHR-13: the agent started again and asks something new.
  it('a new question replaces a pull request error once the agent is back', async () => {
    stage = 'asks'
    failure = { stage: 'pr', title: 'The agent\'s pull request merges into another branch', detail: 'PR #90 merges into main.', agentCanFix: true, at: 1 }
    more = { failureStale: true }
    const task = { ...row(), stage, state: 'blocked', kind: 'question', msg: 'Rebase on v2 or close it?', group: 'needs' as const }
    const w = await panel({ task })
    expect(w.find('.task-needs-type').text()).toBe('Question')
    expect(w.find('.task-needs-text').text()).toBe('Rebase on v2 or close it?')
    expect(w.find('.task-needs').text()).not.toContain('merges into another branch')
    expect(w.find('.task-needs').text()).not.toContain('Send the error to the agent')
    w.unmount()
  })
  // WHR-75: the reviewer, not the agent, shows a dialog (1.x reviewneeds).
  describe('a reviewer that needs you', () => {
    const REVIEW_MSG = 'The reviewer shows a dialog: open it and answer'
    const reviewTask = () => ({ ...row(), stage: 'reviewneeds', state: 'blocked', kind: '', msg: REVIEW_MSG, group: 'needs' as const })
    const buttons = (w: Awaited<ReturnType<typeof panel>>) => w.findAll('.task-needs-actions button').map(b => b.text())
    // The agent's pane (done) and, when given, its reviewer's.
    const withReviewer = (status: 'blocked' | 'working' | null) => {
      const agent = herdrState.value.panes[0]!
      herdrState.value = { ok: true, workspaces: [], panes: [{ ...agent, status: 'done' }, ...(status ? [{ ...agent, id: 'w1:p4', tab: 'w1:t2', agent: 'codex', status }] : [])] }
    }
    it('opens the reviewer\'s pane, never the agent\'s', async () => {
      stage = 'reviewneeds'; msg = REVIEW_MSG
      more = { reviewer: { pane: 'w1:p4' } }
      const w = await panel({ task: reviewTask() }, 'claude')
      withReviewer('blocked')
      await flushPromises()
      expect(w.find('.task-needs h3').text()).toBe(`Needs you · ${REVIEW_MSG}`)
      expect(buttons(w)).toEqual(['Open the reviewer'])
      expect(w.find('.task-needs').text()).not.toContain('Answer in the conversation')
      expect(w.find('.task-needs').text()).not.toContain('Open terminal')
      expect(w.findAll('.board-panel-tabs button').map(b => b.text())).toEqual(['Task', 'Agent', 'Reviewer', 'Settings'])
      await w.find('.task-needs-reviewer-open').trigger('click')
      await flushPromises()
      // Its pane, in its conversation (where the dialog shows as choices).
      expect(w.findAll('.board-panel-tabs button').find(b => b.text() === 'Reviewer')!.classes()).toContain('on')
      expect(w.find('.board-panel-reviewer-who').text()).toContain('Reviewer')
      expect(w.find('.embedded-agent').text()).toBe('chat')
      // Its terminal, by hand.
      await w.find('.board-panel-reviewer-mode').trigger('click')
      expect(w.find('.embedded-agent').text()).toBe('term')
      // Shown already: the banner does not offer it again.
      expect(buttons(w)).toEqual([])
      w.unmount()
    })
    it('says so plainly when wherdr cannot reach the reviewer', async () => {
      stage = 'reviewneeds'; msg = REVIEW_MSG
      more = { reviewer: { pane: null } }
      const w = await panel({ task: reviewTask(), target: { kind: 'task', machine: '', id: 'demo/9-away' } }, 'claude')
      expect(w.find('.task-needs-reviewer').attributes('data-wait')).toBe('away')
      expect(w.find('.task-needs-reviewer').text()).toContain('wherdr cannot reach the reviewer’s pane. Answer it on devbox')
      expect(buttons(w)).toEqual(['Task actions'])
      expect(w.findAll('.board-panel-tabs button').map(b => b.text())).not.toContain('Reviewer')
      w.unmount()
    })
    it('a dialog no longer there: the board\'s words and the task\'s actions, never stuck', async () => {
      stage = 'reviewneeds'; msg = REVIEW_MSG
      more = { reviewer: { pane: 'w1:p4' } }
      // Its pane closed.
      const w = await panel({ task: reviewTask(), target: { kind: 'task', machine: '', id: 'demo/9-gone' } }, 'claude')
      expect(w.find('.task-needs h3').text()).toContain(REVIEW_MSG)
      expect(w.find('.task-needs-reviewer').attributes('data-wait')).toBe('gone')
      expect(buttons(w)).toEqual(['Task actions'])
      await w.find('.task-needs-task').trigger('click')
      expect(w.find('.task-content').exists()).toBe(true)
      w.unmount()
      // Its pane is back at work: the board is behind, it can still be looked at.
      const q = await panel({ task: reviewTask(), target: { kind: 'task', machine: '', id: 'demo/9-quiet' } }, 'claude')
      withReviewer('working')
      await flushPromises()
      expect(q.find('.task-needs-reviewer').attributes('data-wait')).toBe('quiet')
      expect(buttons(q)).toEqual(['Open the reviewer'])
      q.unmount()
    })
    // Review finding: a reviewer in an open session this device does not show is not a closed pane.
    it('a reviewer in a session this device does not show: names it and offers to switch to it', async () => {
      stage = 'reviewneeds'; msg = REVIEW_MSG
      more = { reviewer: { pane: 'abcdef01~w5:p1' } }
      const w = await panel({ task: reviewTask(), target: { kind: 'task', machine: '', id: 'demo/9-hidden' } }, 'claude')
      const agent = herdrState.value.panes[0]!
      allSessionsState.value = {
        ok: true, workspaces: [],
        machines: [{ key: '', label: 'devbox', local: true, status: 'online', error: null }, { key: 'abcdef01', baseKey: '', session: 'review', label: 'devbox', local: true, status: 'online', error: null }],
        panes: [agent, { ...agent, id: 'abcdef01~w5:p1', machine: 'abcdef01', status: 'blocked' }],
      }
      await flushPromises()
      expect(w.find('.task-needs-reviewer').attributes('data-wait')).toBe('hidden')
      expect(w.find('.task-needs-reviewer').text()).toBe('The reviewer runs in the session “review”, which this device does not show. Switch to it to answer.')
      expect(w.find('.task-needs').text()).not.toContain('closed')
      expect(buttons(w)).toEqual(['Switch to that session'])
      await w.find('.task-needs-reviewer-session').trigger('click')
      await vi.waitFor(() => expect(calls).toContainEqual({ machine: '', name: 'review' }))
      w.unmount()
    })
    it('an agent\'s own dialog keeps Open terminal and Answer in the conversation', async () => {
      stage = 'working'
      more = { reviewer: null }
      const task = { ...row(), stage: 'working', state: 'blocked', kind: '', msg: 'Waiting for your answer', group: 'needs' as const }
      const w = await panel({ task, target: { kind: 'task', machine: '', id: 'demo/9-agent' } }, 'claude')
      expect(buttons(w)).toEqual(['Open terminal'])
      expect(w.find('.task-needs-reviewer').exists()).toBe(false)
      await w.find('.task-needs-term').trigger('click')
      expect(buttons(w)).toEqual(['Answer in the conversation'])
      w.unmount()
    })
  })
  // WHR-69: the banner's action follows the kind of wait.
  describe('a wait its agent reported', () => {
    const asks = (kind: string, text: string) => ({ ...row(), stage: 'asks', state: 'blocked', kind, msg: text, group: 'needs' as const })
    const buttons = (w: Awaited<ReturnType<typeof panel>>) => w.findAll('.task-needs-actions button').map(b => b.text())
    it('a question with no answers offered: Reply…, no terminal', async () => {
      stage = 'asks'
      const w = await panel({ task: asks('question', 'Should the old settings file be removed') })
      expect(w.find('.task-needs').attributes('data-kind')).toBe('question')
      expect(buttons(w)).toEqual(['Reply…'])
      expect(w.find('.task-needs').text()).not.toContain('Open terminal')
      w.unmount()
    })
    it('a question with answers: one tap sends one', async () => {
      stage = 'asks'
      const w = await panel({ task: asks('question', 'Which store? (Postgres / SQLite)') })
      expect(buttons(w)).toEqual(['Postgres', 'SQLite'])
      await w.findAll('.task-needs-choice')[1]!.trigger('click')
      await vi.waitFor(() => expect(calls).toContainEqual({ machine: '', id: 'demo/9', text: 'SQLite' }))
      w.unmount()
    })
    it('a permission: Allow and Refuse, Always allow when offered', async () => {
      stage = 'asks'
      const w = await panel({ task: asks('permission', 'Need your OK to delete the test data') })
      expect(buttons(w)).toEqual(['Allow', 'Refuse'])
      await w.find('.task-needs-allow').trigger('click')
      await vi.waitFor(() => expect(calls).toContainEqual({ machine: '', id: 'demo/9', text: 'Allowed: go ahead.' }))
      w.unmount()
      const again = await panel({ task: asks('permission', 'Run npm publish? (yes / always / no)') })
      expect(buttons(again)).toEqual(['Allow', 'Always allow', 'Refuse'])
      again.unmount()
    })
    it('a sign-in keeps Open terminal', async () => {
      stage = 'asks'
      const w = await panel({ task: asks('auth', 'Need a GitHub login to open the PR') }, 'claude')
      expect(w.find('.task-needs-type').text()).toBe('Sign-in')
      expect(buttons(w)).toEqual(['Open terminal'])
      w.unmount()
    })
    it('links are short and clickable', async () => {
      stage = 'asks'
      const w = await panel({ task: asks('question', 'Merge https://github.com/acme/app/pull/484 now?') })
      const a = w.find('.task-needs-text a')
      expect(a.text()).toBe('PR #484')
      expect(a.attributes('href')).toBe('https://github.com/acme/app/pull/484')
      expect(a.attributes('target')).toBe('_blank')
      w.unmount()
    })
    it('machine unavailable: its answers cannot be sent', async () => {
      stage = 'asks'
      const w = await panel({ task: asks('permission', 'Need your OK to delete the test data'), reachable: false })
      const allow = w.find('.task-needs-allow')
      expect(allow.attributes('disabled')).toBeDefined()
      await allow.trigger('click')
      expect(calls).toHaveLength(0)
      w.unmount()
    })
    it('a numbered offer to allow for good gets its button', async () => {
      stage = 'asks'
      const w = await panel({ task: asks('permission', 'Run the cleanup?\n1) Allow once\n2) Always allow\n3) Refuse') })
      expect(buttons(w)).toEqual(['Allow', 'Always allow', 'Refuse'])
      w.unmount()
    })
  })
  it('a current failure keeps its title and its buttons', async () => {
    failure = { stage: 'pr', title: 'Could not open the pull request', detail: 'gh failed', agentCanFix: true, at: 1 }
    more = { failureStale: false }
    const w = await panel()
    expect(w.find('.task-needs h3').text()).toBe('Needs you · Could not open the pull request')
    expect(w.find('.task-needs').text()).toContain('Send the error to the agent')
    expect(w.find('.task-needs').text()).not.toContain('Finish')
    w.unmount()
  })
  it('Finish on a limit stop asks first, then sends finish', async () => {
    stage = 'stopped'
    const task = { ...row(), stage, state: 'blocked', msg: 'Stopped at its token limit', group: 'needs' as const }
    const w = await panel({ task })
    const finish = () => w.findAll('.task-needs button').find(b => b.text() === 'Take as is')!
    await vi.waitFor(() => expect(finish().attributes('disabled')).toBeUndefined())
    expect(finish().attributes('title')).toBe('Take the work as it is: checks, then review')
    decision.yes = false
    await finish().trigger('click'); await flushPromises()
    expect(calls).toHaveLength(0)
    decision.yes = true
    await finish().trigger('click')
    await vi.waitFor(() => expect(calls).toContainEqual({ machine: '', id: 'demo/9', action: 'finish' }))
    w.unmount()
  })
  it('stopped without a summary: Retry and Finish, each said', async () => {
    stage = 'nosummary'
    const w = await panel({ task: { ...row(), stage, group: 'needs' as const } })
    expect(w.findAll('.task-needs button').map(b => b.text())).toEqual(expect.arrayContaining(['Retry', 'Finish']))
    expect(w.find('.task-finish-why').text()).toContain('its screen as the summary')
    w.unmount()
  })
  it('a row stuck at "Finishing": Finish while its agent rests, nothing while it works', async () => {
    stage = 'working'
    const task = { ...row(), stage, state: 'working', msg: 'Finishing', group: 'working' as const }
    const w = await panel({ task, target: { kind: 'task', machine: '', id: `demo/9-${Math.random()}` } }, 'claude')
    expect(w.find('.task-needs h3').text()).toBe('Finishing · its agent is at rest')
    expect(w.findAll('.task-needs button').map(b => b.text())).toContain('Finish')
    expect(w.find('.task-needs').text()).not.toContain('Retry')
    w.unmount()
    const busy = await panel({ task, target: { kind: 'task', machine: '', id: `demo/9-${Math.random()}` } }, 'claude', 'working')
    expect(busy.find('.task-needs').exists()).toBe(false)
    busy.unmount()
  })
})

describe('the task panel header says what a Working task is doing', () => {
  const working = (s: string, m: string) => parseTaskRow({ id: 'demo/9', title: 'Improve search', stage: s, state: 'working', app: 'claude', msg: m })!
  it('an agent running: no badge', async () => {
    stage = 'working'
    const w = await panel({ task: working('working', 'Writing tests') }, 'claude', 'working')
    expect(w.find('.board-panel-who > .task-activity').exists()).toBe(false)
    w.unmount()
  })
  it('waiting for GitHub checks: CI 1/2, the header marked', async () => {
    stage = 'merging'
    const w = await panel({ task: working('merging', 'Waiting for GitHub checks · 1 of 2 passed') }, 'claude')
    expect(w.find('.board-panel-who > .task-activity').text()).toBe('CI 1/2')
    expect(w.find('.board-panel-head').classes()).toContain('activity-ci')
    w.unmount()
  })
  it('queued: QUEUED with what it waits for', async () => {
    stage = 'after'
    const w = await panel({ task: working('after', 'queued after DEMO-70') })
    expect(w.find('.board-panel-who > .task-activity').text()).toBe('Queued · DEMO-70')
    expect(w.find('.board-panel-head').classes()).toContain('activity-queued')
    w.unmount()
  })
})

it('keeps settings loaded through board row refreshes and tab switches', async () => {
  const w = await panel({ target: { kind: 'task', machine: '', id: 'demo/settings-cache' } }, 'claude')
  expect(settingsReads).toBe(0)
  const tab = (name: string) => w.findAll('.board-panel-tabs button').find(button => button.text() === name)!
  await tab('Settings').trigger('click')
  await vi.waitFor(() => expect(w.find('.task-settings').text()).toContain('No settings returned'))
  expect(settingsReads).toBe(1)
  expect(w.find('.embedded-agent').exists()).toBe(false)
  await w.setProps({ task: { ...row(), msg: 'Board refreshed' } })
  await flushPromises()
  expect(settingsReads).toBe(1)
  await tab('Task').trigger('click')
  await tab('Settings').trigger('click')
  await flushPromises()
  expect(settingsReads).toBe(1)
  w.unmount()
})

it('ends a waiting conversation on the target machine', async () => {
  stage = 'asks'
  more = { chat: true }
  const w = await panel({ target: { kind: 'task', machine: 'remote', id: 'demo/9' }, task: { ...row(), chat: true, state: 'blocked', group: 'needs' } })
  expect(w.find('.task-finish').text()).toBe('End conversation')
  expect(w.find('.task-finish-why').text()).not.toContain('limit')
  await w.find('.task-finish').trigger('click')
  await flushPromises()
  expect(calls).toContainEqual({ machine: 'remote', id: 'demo/9', action: 'finish' })
  w.unmount()
})
