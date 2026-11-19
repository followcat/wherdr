import { afterEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody, setResponseStatus } from 'h3'
import BacklotStudioSheet from '~/components/BacklotStudioSheet.vue'
import { herdrState } from '~/composables/useHerdr'
import type { BacklotMachineView, BacklotRole, BacklotStudio } from '#shared/backlot'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

registerEndpoint('/api/backlot', () => ({ ok: true, machines: [] }))
const posts: unknown[] = []
let failAction = false
registerEndpoint('/api/backlot/action', { method: 'POST', handler: async (event) => {
  posts.push(await readBody(event))
  if (failAction) { setResponseStatus(event, 502); return { ok: false, error: 'The backlot command failed.' } }
  return { ok: true, output: 'done' }
} })

const role = (more: Partial<BacklotRole> = {}): BacklotRole => ({ role: 'dev', name: 'alice', terminal: 'host-a/t1', state: 'live', work: 'working', doing: 'writing the form', ...more })
const studio = (more: Partial<BacklotStudio> = {}): BacklotStudio => ({ id: 'shop', title: 'Acme shop', state: 'live', requirement_version: 4, open_reviews: 0, waiting: 1, roles: [], ...more })
const machine = (more: Partial<BacklotMachineView> = {}): BacklotMachineView => ({
  machine: '', label: 'host-a', stageRunning: true, backlotVersion: '1.0.0',
  summary: { schema: 'backlot/1', updated_ms: 1, studios: [], hollywood: null }, ...more,
})

const $ = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const wait = (sel: string) => vi.waitFor(() => expect($(sel)).not.toBeNull())

let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
afterEach(() => {
  w?.unmount()
  w = null
  posts.length = 0
  failAction = false
  navigate.mockReset()
  herdrState.value = { ok: false, workspaces: [], panes: [] }
  document.body.innerHTML = ''
})

async function mountSheet(s: BacklotStudio, m = machine()) {
  w = await mountSuspended(BacklotStudioSheet, { props: { open: true, machine: m, studio: s }, attachTo: document.body })
  await wait('[data-testid="backlot-studio-sheet"]')
}

async function type(sel: string, value: string) {
  const input = $<HTMLInputElement>(sel)!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
}

// An action button is disabled while another action runs: wait until it takes the tap.
async function press(sel: string) {
  await vi.waitFor(() => expect($<HTMLButtonElement>(sel)?.disabled).toBe(false))
  $<HTMLButtonElement>(sel)!.click()
}

it('shows open attentions, the cast, the tasks and the studio Hollywood cards', async () => {
  const s = studio({
    roles: [
      role({ attention: 'permission prompt', attention_user: true, attention_seq: 7, attention_detail: 'rm -rf build' }),
      role({ role: 'qa', name: 'bob', terminal: null, work: 'working', doing: 'reviewing' }),
    ],
    tasks: [{ id: 'T1', title: 'Checkout', status: 'doing', priority: 'high', requirement_version: 4, rework_rounds: 0, rework_cap: 2, actor_role: 'dev', actor_name: 'alice', latest_verdict: 'pass' }],
  })
  const m = machine({ summary: { schema: 'backlot/1', updated_ms: 1, studios: [s], hollywood: { state: 'live', cards: [{ id: 'c1', studio: 'shop', action: 'merge', why: 'green' }] } } })
  await mountSheet(s, m)
  const text = $('[data-testid="backlot-studio-sheet"]')!.textContent || ''
  expect(text).toContain('Waiting for you')
  expect(text).toContain('alice')
  expect(text).toContain('USER')
  expect(text).toContain('permission prompt')
  expect(text).toContain('rm -rf build')
  expect(text).toContain('Cast')
  expect(text).toContain('bob')
  expect(text).toContain('Working')
  expect(text).toContain('Tasks')
  expect(text).toContain('T1')
  expect(text).toContain('Checkout')
  expect(text).toContain('Hollywood cards')
  expect(text).toContain('merge')
  expect(text).toContain('green')
})

it('sends Allow, Deny and Clear with their exact payloads and shows the result', async () => {
  const s = studio({ roles: [role({ attention: 'permission prompt', attention_seq: 7 })] })
  await mountSheet(s)
  await press('[data-testid="backlot-allow"]')
  await vi.waitFor(() => expect(posts).toEqual([{ kind: 'approve', machine: '', studio: 'shop', person: 'alice', decision: 'allow' }]))
  await vi.waitFor(() => expect($('[data-testid="backlot-feedback"]')?.textContent).toBe('done'))
  await press('[data-testid="backlot-deny"]')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'approve', machine: '', studio: 'shop', person: 'alice', decision: 'deny' }))
  await press('[data-testid="backlot-clear"]')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'attention-clear', machine: '', studio: 'shop', seq: 7 }))
})

it('applies and cancels the studio cards', async () => {
  const s = studio({ roles: [role()] })
  const m = machine({ summary: { schema: 'backlot/1', updated_ms: 1, studios: [s], hollywood: { state: 'live', cards: [{ id: 'c4', studio: 'shop', action: 'merge', why: 'green' }] } } })
  await mountSheet(s, m)
  await press('[data-testid="backlot-sheet-card-apply"]')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'card-apply', machine: '', cardId: 'c4' }))
  await press('[data-testid="backlot-sheet-card-cancel"]')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'card-cancel', machine: '', cardId: 'c4' }))
})

it('tells a role from its quick Tell form', async () => {
  await mountSheet(studio({ roles: [role()] }))
  $('[data-testid="backlot-role-dev"] [data-testid="backlot-role-tell"]')!.click()
  await wait('[data-testid="backlot-tell-send"]')
  await type('[data-testid="backlot-role-dev"] input', 'ship the form')
  await press('[data-testid="backlot-tell-send"]')
  await vi.waitFor(() => expect(posts).toEqual([{ kind: 'tell', machine: '', studio: 'shop', role: 'dev', text: 'ship the form' }]))
})

it('opens the terminal of a live role and closes the sheet', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [{ id: 'w:p1', coreAddress: 'host-a/t1', status: 'working', agent: 'claude', workspace: 'w', tab: 't' }] }
  await mountSheet(studio({ roles: [role()] }))
  $('[data-testid="backlot-role-dev"] .bls-role-main')!.click()
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/a/w%3Ap1'))
})

it('starts a stopped stage from the sheet', async () => {
  await mountSheet(studio({ roles: [role()] }), machine({ stageRunning: false }))
  expect($('[data-testid="backlot-sheet-stage-start"]')).not.toBeNull()
  await press('[data-testid="backlot-sheet-stage-start"]')
  await vi.waitFor(() => expect(posts).toEqual([{ kind: 'stage-start', machine: '' }]))
})

it('shows the error of a refused action', async () => {
  failAction = true
  await mountSheet(studio({ roles: [role()] }), machine({ stageRunning: false }))
  await press('[data-testid="backlot-sheet-stage-start"]')
  await vi.waitFor(() => expect($('[data-testid="backlot-feedback"]')?.textContent).toBe('The backlot command failed.'))
})
