// WHR-250: the Workflow tab is a read-only diagram per task type; a change
// goes through the project's coordinator.
import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ProjectWorkflow from '~/components/ProjectWorkflow.vue'
import WorkflowChart from '~/components/WorkflowChart.vue'
import { herdrState } from '~/composables/useHerdr'
import { coordinators } from '~/composables/useCoordinators'
import { panePath } from '~/composables/useWorkspaces'
import { useDraft } from '~/composables/useDraft'
import { company, github, wherdr } from '#shared/pm/examples'
import type { Guards } from '#shared/pm/workflow'
import type { Project } from '#shared/pm/project'
import type { Pane } from '#shared/types'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

const project: Project = { key: 'WEB', name: 'Web', machine: '', path: '~/project', addedAt: 1 }
let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; coordinators.value = []; navigate.mockClear(); document.body.innerHTML = '' })
const mount = async () => (mounted = await mountSuspended(ProjectWorkflow, {
  attachTo: document.body,
  props: { project, workflow: { ...wherdr, version: 2 }, log: [], templates: [] },
}))
type W = Awaited<ReturnType<typeof mount>>
const nodes = (w: W) => w.findAll('[data-testid="wf-node"]').map(n => ({
  id: n.attributes('data-step'), kind: n.classes().find(c => c.startsWith('k-')),
  who: n.find('[data-testid="wf-who"]').text(), ends: n.find('[data-testid="wf-ends"]').exists() ? n.find('[data-testid="wf-ends"]').text() : '',
}))

it('draws every step of each task type with its holder, agent and ending, the send-back loop and the user\'s merge', async () => {
  const w = await mount()
  // Nothing edits the workflow here.
  expect(w.findAll('input, textarea, select, [role="combobox"]')).toHaveLength(0)
  const opus = 'Claude · claude-opus-5-5'
  expect(nodes(w)).toEqual([
    { id: 'todo', kind: 'k-edge', who: 'Start', ends: '' },
    { id: 'work', kind: 'k-agent', who: `Worker${opus}`, ends: 'Ends Its report' },
    { id: 'pr', kind: 'k-engine', who: 'The engine', ends: 'Ends Open a GitHub PR to v3' },
    { id: 'review', kind: 'k-agent', who: `Reviewer${opus}`, ends: 'Ends A verdict: pass or send back' },
    { id: 'merge', kind: 'k-engine', who: 'The engine', ends: 'Ends Merge the GitHub PR · squash · once smoke green' },
    { id: 'done', kind: 'k-edge', who: 'Finish', ends: '' },
  ])
  expect(w.find('[data-testid="wf-loop"]').text()).toBe('Sends back to work, up to 3 rounds, then you decide')
  expect(w.findAll('.wf-back')).toHaveLength(1)
  // The route line says how the types differ.
  expect(w.find('[data-testid="wf-route"]').text()).toBe('Worker→Open a GitHub PR to v3→Reviewer, up to 3 rounds→Merge the GitHub PR')
  expect(w.find('[data-testid="wf-guard"]').text()).toBe('v3 is not protected: the engine merges')

  await w.find('[data-type="visual"]').trigger('click')
  const visual = nodes(w)
  expect(visual.map(n => n.id)).toEqual(['todo', 'work', 'pr', 'review', 'merge', 'done'])
  expect(visual[4]).toEqual({ id: 'merge', kind: 'k-you', who: 'You', ends: 'Ends Your button “Accept” → Merge the GitHub PR · squash · once smoke green' })
  expect(w.find('[data-step="work"]').text()).toContain('Screenshots')
  expect(w.find('[data-testid="wf-route"]').text()).toBe('Worker, with screenshots→Open a GitHub PR to v3→Reviewer, up to 3 rounds→You press “Accept”')

  await w.find('[data-type="study"]').trigger('click')
  expect(nodes(w).map(n => n.id)).toEqual(['todo', 'work', 'done'])
  expect(w.findAll('.wf-back')).toHaveLength(0)
})

it('shows the JSON read only, with Copy', async () => {
  const writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const w = await mount()
  await w.find('[data-testid="wf-json-open"]').trigger('click')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="wf-json"]')).not.toBeNull())
  const pre = document.querySelector('[data-testid="wf-json"]')!
  expect(pre.tagName).toBe('PRE')
  expect(JSON.parse(pre.textContent!)).toMatchObject({ id: 'wherdr', version: 2 })
  document.querySelector<HTMLElement>('[data-testid="wf-json-copy"]')!.click()
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(pre.textContent))
})

it('"Ask the coordinator" opens its conversation with a first message to complete', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [{ id: 'w1:p7', coreAddress: 'host/t1', status: 'idle', agent: 'claude', workspace: 'w', tab: 't' } as Pane] }
  coordinators.value = [{ project: 'WEB', name: 'Web', agent: { program: 'claude' }, terminal: 'host/t1' }]
  const w = await mount()
  await w.find('[data-type="visual"]').trigger('click')
  await w.find('[data-testid="wf-ask"]').trigger('click')
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(panePath('w1:p7')))
  expect(useDraft('w1:p7').text).toBe('I would like to change the workflow of WEB (task type visual): ')
})

it('shows the user step\'s real button, and branch protection apart from who merges', async () => {
  const chart = (workflow: typeof github, type: string) => mountSuspended(WorkflowChart, { props: { workflow, type } })
  const c = await chart(company, 'feature')
  expect(c.find('[data-step="merge"] [data-testid="wf-ends"]').text()).toContain('Your button “I merged it”')
  const guard = async (guards: Guards) => (await chart({ ...github, guards }, 'simple')).find('[data-step="merge"] [data-testid="wf-guard"]').text()
  expect(await guard({ protected: ['next'], merge: { protected: 'engine', others: 'engine' } })).toBe('next is protected: the engine merges')
  expect(await guard({ protected: ['main'], merge: { protected: 'user', others: 'user' } })).toBe('next is not protected: you merge')
  expect(await guard({ protected: ['next'], merge: { protected: 'user', others: 'engine' } })).toBe('next is protected: you merge')
})
