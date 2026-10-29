import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import BoardPanel from '~/components/BoardPanel.vue'
import { defaultViewMode, herdrState } from '~/composables/useHerdr'
import { setTaskPanelChoice } from '~/utils/taskPanelTab'
import type { Pane } from '#shared/types'

// What `coordinator status` says now, and how many times it was asked.
type Status = { pane: string | null, state: string, error?: string, name?: string, queued?: number }
let status: Status = { pane: 'w1:p1', state: 'idle' }
let asked = 0
// When set, each lookup waits until the test answers it, in the order it picks.
let holding = false
const waiting: Array<(r: Status) => void> = []
registerEndpoint('/api/tasks/coordinator', { method: 'GET', handler: () => {
  asked++
  return holding ? new Promise(resolve => waiting.push(resolve)) : status
} })
// What was sent to it (a first message, Try again).
const posted: unknown[] = []
registerEndpoint('/api/tasks/coordinator', { method: 'POST', handler: async (event) => {
  const b = await readBody(event) as { to?: { kind: string, repo?: string } }
  posted.push(b)
  // A folder the board did not know: the server added it under a name.
  return { ok: true, msg: 'done', ...(b.to?.repo === '/repos/new-demo' ? { repo: 'new-demo' } : {}) }
} })

const pane = (id: string): Pane => ({ id, workspace: id.split(':')[0]!, tab: `${id.split(':')[0]}:t1`, tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/tmp/demo', agentSession: null })
const setPanes = (ids: string[]) => { herdrState.value = { ok: true, workspaces: [], panes: ids.map(pane) } }

type To = { kind: 'main' } | { kind: 'machine' } | { kind: 'project', repo: string }
async function panel(reachable = true, to: To = { kind: 'main' }) {
  const w = await mountSuspended(BoardPanel, {
    props: { target: { machine: '', kind: 'coordinator', to }, task: null, machineLabel: 'Local', reachable },
    global: { stubs: { AgentView: true, FoldText: true } },
  })
  await flushPromises()
  return { w, vm: w.vm as unknown as { coordShown: string | null } }
}

describe('the Board panel follows its coordinator', () => {
  afterEach(() => { vi.useRealTimers(); holding = false; waiting.length = 0; herdrState.value = { ok: false, workspaces: [], panes: [] }; status = { pane: 'w1:p1', state: 'idle' }; asked = 0; posted.length = 0 })

  it('opens the existing known project conversation from New without a first-message form or a POST', async () => {
    status = { pane: 'w2:p1', state: 'idle' }
    setPanes(['w2:p1'])
    const { w, vm } = await panel(true, { kind: 'project', repo: 'demo' })
    try {
      await w.setProps({ target: { machine: '', kind: 'coordinator', to: { kind: 'project', repo: 'demo' }, freshProject: true } })
      await vi.waitFor(() => expect(vm.coordShown).toBe('w2:p1'))
      expect(w.find('#board-panel-first').exists()).toBe(false)
      expect(w.find('#coordinator-agent').exists()).toBe(false)
      expect(posted).toEqual([])
    } finally { w.unmount() }
  })

  it('keeps the first message empty and sends launch choices only for a new project', async () => {
    status = { pane: null, state: 'none' }
    const { w } = await panel(true, { kind: 'project', repo: '/repos/new-demo' })
    await w.setProps({ target: { machine: '', kind: 'coordinator', to: { kind: 'project', repo: '/repos/new-demo' }, freshProject: true } })
    await flushPromises()
    expect(posted).toEqual([])
    await vi.waitFor(() => expect(w.find('#coordinator-agent').exists()).toBe(true))
    const vm = w.vm as unknown as { first: string, launchAgent: string, launchModel: string, launchEffort: string, start: () => Promise<void> }
    vm.launchAgent = 'codex'
    vm.launchModel = 'demo-model'
    vm.launchEffort = 'high'
    vm.first = 'Plan this project'
    await vm.start()
    expect(posted).toEqual([{ machine: '', to: { kind: 'project', repo: '/repos/new-demo' }, text: 'Plan this project', start: { agent: 'codex/demo-model', effort: 'high' } }])
    // From now on the coordinator is named by the repo's name on the board.
    expect(w.emitted('retarget')).toEqual([[{ kind: 'project', repo: 'new-demo' }]])
    w.unmount()
  })

  it('a coordinator restarted in a new pane is shown without closing the panel', async () => {
    setPanes(['w1:p1'])
    const { w, vm } = await panel()
    expect(vm.coordShown).toBe('w1:p1')
    vi.useFakeTimers()
    // Its pane closes, and Herdr starts it again in another one.
    status = { pane: 'w2:p1', state: 'idle' }
    setPanes(['w2:p1'])
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(vm.coordShown).toBe('w2:p1')
    w.unmount()
  })

  it('a coordinator started from Herdr while none was there shows up', async () => {
    status = { pane: null, state: 'none' }
    setPanes(['w5:p1'])
    const { w, vm } = await panel()
    expect(vm.coordShown).toBeNull()
    vi.useFakeTimers()
    status = { pane: 'w3:p1', state: 'idle' }
    setPanes(['w5:p1', 'w3:p1'])
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(vm.coordShown).toBe('w3:p1')
    w.unmount()
  })

  it('asks again when its machine is back', async () => {
    status = { pane: null, state: 'none' }
    setPanes([])
    const { w } = await panel(false)
    const before = asked
    status = { pane: 'w1:p1', state: 'idle' }
    await w.setProps({ reachable: true })
    await flushPromises()
    expect(asked).toBe(before + 1)
    w.unmount()
  })

  it('a shown coordinator is not asked again while Herdr keeps its pane', async () => {
    setPanes(['w1:p1'])
    const { w } = await panel()
    const before = asked
    vi.useFakeTimers()
    setPanes(['w1:p1', 'w4:p1'])
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5000)
    expect(asked).toBe(before)
    w.unmount()
  })

  for (const to of [{ kind: 'main' }, { kind: 'machine' }, { kind: 'project', repo: 'demo' }] as To[]) {
    it(`two lookups answered in reverse order keep the latest answer (${to.kind})`, async () => {
      setPanes(['w3:p1'])
      holding = true
      // The first lookup, from opening, is still out when its machine is back.
      const { w, vm } = await panel(false, to)
      await w.setProps({ reachable: true })
      await flushPromises()
      expect(waiting).toHaveLength(2)
      const [first, second] = waiting
      second!({ pane: 'w3:p1', state: 'idle' })
      await vi.waitFor(() => expect(vm.coordShown).toBe('w3:p1'))
      first!({ pane: null, state: 'none' })
      // Time for the earlier answer to arrive and be dropped.
      for (let i = 0; i < 10; i++) await flushPromises()
      await new Promise(r => setTimeout(r, 100))
      expect(vm.coordShown).toBe('w3:p1')
      w.unmount()
    })
  }

  it('an earlier lookup\'s "starting" answer schedules no retry', async () => {
    setPanes(['w3:p1'])
    holding = true
    const { w, vm } = await panel(false)
    await w.setProps({ reachable: true })
    await flushPromises()
    const [first, second] = waiting
    second!({ pane: 'w3:p1', state: 'idle' })
    await vi.waitFor(() => expect(vm.coordShown).toBe('w3:p1'))
    const before = asked
    first!({ pane: null, state: 'starting' })
    await new Promise(r => setTimeout(r, 3300))
    expect(asked).toBe(before)
    expect(vm.coordShown).toBe('w3:p1')
    w.unmount()
  })
  const NOT_INSTALLED = '"claude" is not installed here, so it cannot be the Coordinator.'

  it('a start herdr-projects gave up on says why, never "starting", and asks nothing more', async () => {
    // Its words still wait (state "starting"), only a shell pane opened, and the error is kept.
    status = { pane: null, state: 'starting', error: NOT_INSTALLED, name: 'Coordinator' }
    setPanes(['w9:p1'])
    const { w } = await panel()
    const failed = w.find('.board-panel-failed')
    expect(failed.exists()).toBe(true)
    expect(failed.text()).toContain('The Coordinator could not start on Local.')
    expect(failed.find('.board-panel-failed-why').text()).toBe(NOT_INSTALLED)
    expect(w.text()).not.toContain('is starting')
    expect(w.find('#board-panel-first').exists()).toBe(false)
    // Not tried again by itself: no lookup every 3 seconds.
    const before = asked
    await new Promise(r => setTimeout(r, 3300))
    expect(asked).toBe(before)
    w.unmount()
  })

  for (const queued of [0, 1, 3]) {
    for (const delivery of [false, true]) {
      it(`describes ${delivery ? 'delivery' : 'startup'} failure with ${queued} queued messages`, async () => {
        status = { pane: null, state: 'exited', queued, error: delivery ? 'your message sits unsent in its box. Go into it and press enter.' : NOT_INSTALLED }
        setPanes([])
        const { w } = await panel()
        const failed = w.find('.board-panel-failed')
        expect(failed.find('h4').text()).toBe(delivery ? 'Message could not be sent' : 'Could not start')
        expect(failed.attributes('aria-label')).toBe(delivery ? 'Message could not be sent' : 'Could not start')
        expect(failed.find('.board-panel-failed-what').text()).toBe(delivery
          ? 'The message was not sent to Coordinator on Local.'
          : 'The Coordinator could not start on Local.')
        expect(failed.find('.board-panel-failed-next').text()).toContain(queued
          ? `${queued} message${queued === 1 ? '' : 's'} still waiting`
          : 'No message is waiting.')
        w.unmount()
      })
    }
  }

  it('does not infer a queued message from an error when the count is missing', async () => {
    status = { pane: null, state: 'starting', error: NOT_INSTALLED }
    setPanes([])
    const { w } = await panel()
    expect(w.find('.board-panel-failed-next').text()).toContain('The message queue status is unavailable.')
    expect(w.find('.board-panel-failed-next').text()).not.toContain('still waiting')
    w.unmount()
  })

  it('shows the conversation when a live pane has an earlier delivery error', async () => {
    status = { pane: 'w1:p1', state: 'idle', queued: 0, error: 'your message sits unsent in its box. Go into it and press enter.' }
    setPanes(['w1:p1'])
    const { w, vm } = await panel()
    expect(vm.coordShown).toBe('w1:p1')
    expect(w.find('.board-panel-failed').exists()).toBe(false)
    w.unmount()
  })

  it('Try again starts it again with nothing typed, then follows its start', async () => {
    status = { pane: null, state: 'starting', error: NOT_INSTALLED }
    setPanes([])
    const { w } = await panel(true, { kind: 'project', repo: 'web' })
    expect(w.find('.board-panel-failed').text()).toContain('The web coordinator could not start on Local.')
    status = { pane: null, state: 'starting' }
    await w.find('.board-panel-failed button').trigger('click')
    await flushPromises()
    expect(posted).toEqual([{ machine: '', to: { kind: 'project', repo: 'web' }, restart: true }])
    await vi.waitFor(() => expect(w.find('.board-panel-starting').exists()).toBe(true))
    expect(w.find('.board-panel-starting').text()).toBe('Sent. The web coordinator is starting: its conversation opens here.')
    expect(w.find('.board-panel-failed').exists()).toBe(false)
    // It fails again: the reason is back.
    status = { pane: null, state: 'starting', error: NOT_INSTALLED }
    await vi.waitFor(() => expect(w.find('.board-panel-failed').exists()).toBe(true), { timeout: 4500 })
    w.unmount()
  })

  it('Try again waits while its machine cannot be reached', async () => {
    status = { pane: null, state: 'starting', error: NOT_INSTALLED }
    setPanes([])
    const { w } = await panel(false)
    expect(w.find('.board-panel-failed button').attributes('disabled')).toBeDefined()
    expect(w.find('.board-panel-failed .board-panel-away').exists()).toBe(true)
    w.unmount()
  })

  for (const [to, name, starting] of [
    [{ kind: 'main' }, 'Coordinator', 'Sent. The Coordinator is starting: its conversation opens here.'],
    [{ kind: 'machine' }, 'Local coordinator', 'Sent. The Local coordinator is starting: its conversation opens here.'],
    [{ kind: 'project', repo: 'wherdr' }, 'wherdr coordinator', 'Sent. The wherdr coordinator is starting: its conversation opens here.'],
  ] as [To, string, string][]) {
    it(`names the ${name} once, in its heading and while it starts`, async () => {
      // Named as on the Board button (the machine's wherdr name), whatever herdr-projects calls its host.
      status = { pane: null, state: 'none', name: to.kind === 'machine' ? 'devbox coordinator' : '' }
      setPanes([])
      const { w } = await panel(true, to)
      expect(w.find('.board-panel-title').text()).toBe(name)
      status = { pane: null, state: 'starting' }
      await w.find('#board-panel-first').setValue('hello')
      await w.find('form').trigger('submit')
      await flushPromises()
      await vi.waitFor(() => expect(w.find('.board-panel-starting').exists()).toBe(true))
      expect(w.find('.board-panel-starting').text()).toBe(starting)
      expect(w.text()).not.toMatch(/coordinator coordinator/i)
      w.unmount()
    })
  }

  it('says "starting" only while herdr-projects does: one that is not running gets the first-message field again', async () => {
    status = { pane: null, state: 'starting' }
    setPanes([])
    const { w } = await panel()
    expect(w.find('.board-panel-starting').text()).toBe('The Coordinator is starting: its conversation opens here.')
    status = { pane: null, state: 'exited' }
    await vi.waitFor(() => expect(w.find('#board-panel-first').exists()).toBe(true), { timeout: 4500 })
    expect(w.find('.board-panel-starting').exists()).toBe(false)
    w.unmount()
  })
})

// A task's agent with no pane: what its details say, and what `tell` received.
const told: unknown[] = []
let taskAgentPane: string | null = null
registerEndpoint('/api/tasks/details', () => ({
  id: 'demo/3', title: 'Add dark mode', msg: '', description: '', agent: 'claude', pr: '', branch: '', worktree: '',
  failure: '', failureStage: '', failureAuth: false, stage: 'working', summary: '', report: null, review: null, reviewRounds: 0, plan: '', research: false, pane: taskAgentPane,
}))
registerEndpoint('/api/tasks/tell', { method: 'POST', handler: async (event) => {
  told.push(await readBody(event))
  return { ok: true, msg: 'sent' }
} })
const working = {
  id: 'demo/3', repo: 'demo', n: 3, state: 'working', kind: '', stage: 'working', title: 'Add dark mode', msg: '', app: 'claude',
  progress: null, eta: null, pr: '', review: null, reviewRound: 0, research: false, archived: false, queue: null, group: 'working' as const,
}
async function taskPanel(chat: boolean, extra: Record<string, unknown> = {}) {
  const noAgent: number[] = []
  const w = await mountSuspended(BoardPanel, {
    props: { target: { machine: 'far', kind: 'task', id: 'demo/3', chat }, task: working, machineLabel: 'Far', reachable: true, onNoAgent: () => noAgent.push(1), ...extra },
    global: { stubs: { AgentView: true, FoldText: true } },
  })
  await flushPromises()
  return { w, noAgent }
}

describe('the Board panel for a task whose agent has no pane', () => {
  afterEach(() => { told.length = 0; herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('opened from the sheet\'s chat: a message field, sent through herdr-projects (tell)', async () => {
    const { w, noAgent } = await taskPanel(true)
    await vi.waitFor(() => expect(w.find('#board-panel-tell').exists()).toBe(true))
    expect(noAgent).toEqual([])
    const vm = w.vm as unknown as { reply: string, tell: () => Promise<void> }
    vm.reply = '--keep it short'
    await vm.tell()
    await flushPromises()
    expect(told).toEqual([{ machine: 'far', id: 'demo/3', text: '--keep it short' }])
    expect(vm.reply).toBe('')
    w.unmount()
  })

  it('opened from its card: keeps the panel and offers a reply', async () => {
    const { w, noAgent } = await taskPanel(false)
    expect(noAgent).toEqual([])
    expect(w.find('#board-panel-tell').exists()).toBe(true)
    w.unmount()
  })
})


describe('the task Agent tab', () => {
  beforeEach(() => { setTaskPanelChoice('far|demo/3', null) })
  afterEach(() => {
    taskAgentPane = null
    defaultViewMode.value = 'chat'
    herdrState.value = { ok: false, workspaces: [], panes: [] }
  })

  it('combines both modes and keeps the selection through Task and legacy destinations', async () => {
    taskAgentPane = 'w1:p1'
    setPanes(['w1:p1'])
    const { w } = await taskPanel(true)
    try {
      await vi.waitFor(() => expect(w.find('.board-panel-agent-bar').exists()).toBe(true))
      expect(w.findAll('.board-panel-tabs button').map(b => b.text())).toEqual(['Task', 'Agent', 'Settings'])
      const view = () => w.findComponent({ name: 'AgentView' })
      expect(view().props('selectedMode')).toBe('chat')
      await w.get('.board-panel-agent-bar button').trigger('click')
      expect(view().props('selectedMode')).toBe('term')
      await w.findAll('.board-panel-tabs button')[0]!.trigger('click')
      await w.findAll('.board-panel-tabs button')[1]!.trigger('click')
      expect(view().props('selectedMode')).toBe('term')
      await w.setProps({ target: { machine: 'far', kind: 'task', id: 'demo/3', mode: 'chat' } })
      expect(view().props('selectedMode')).toBe('chat')
      await w.setProps({ target: { machine: 'far', kind: 'task', id: 'demo/3', mode: 'term' } })
      expect(view().props('selectedMode')).toBe('term')
    } finally { w.unmount() }
  })

  it('follows Default pane view and offers only the terminal without a readable chat', async () => {
    taskAgentPane = 'w1:p1'
    setPanes(['w1:p1'])
    defaultViewMode.value = 'term'
    const { w } = await taskPanel(false)
    try {
      await vi.waitFor(() => expect(w.find('.board-panel-agent-bar').exists()).toBe(true))
      const view = () => w.findComponent({ name: 'AgentView' })
      expect(view().props('selectedMode')).toBe('term')
      defaultViewMode.value = 'chat'
      await flushPromises()
      expect(view().props('selectedMode')).toBe('chat')
      herdrState.value = { ...herdrState.value, panes: [{ ...herdrState.value.panes[0]!, agent: null }] }
      await flushPromises()
      expect(w.find('.board-panel-agent-bar button').exists()).toBe(false)
      expect(view().props('selectedMode')).toBe('term')
    } finally { w.unmount() }
  })
})
