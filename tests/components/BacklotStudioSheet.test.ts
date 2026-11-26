import { afterEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody, setResponseStatus } from 'h3'
import BacklotStudioSheet from '~/components/BacklotStudioSheet.vue'
import { allSessionsState, herdrState, pickSessionTab } from '~/composables/useHerdr'
import type { BacklotDesign, BacklotMachineView, BacklotRole, BacklotStudio } from '#shared/backlot'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

registerEndpoint('/api/backlot', () => ({ ok: true, machines: [] }))
registerEndpoint('/api/backlot/doc', () => ({ ok: true, file: 'design/v1.md', text: '# Design\n\n## R1\n\n### §R1.W Proposal\n\nBody\n', truncated: false }))
const posts: unknown[] = []
let failAction = false
registerEndpoint('/api/backlot/action', { method: 'POST', handler: async (event) => {
  posts.push(await readBody(event))
  if (failAction) { setResponseStatus(event, 502); return { ok: false, error: 'The backlot command failed.' } }
  return { ok: true, output: 'done' }
} })

const role = (more: Partial<BacklotRole> = {}): BacklotRole => ({ role: 'dev', name: 'alice', terminal: 'host-a/t1', state: 'live', work: 'working', doing: 'writing the form', ...more })
const design = (more: Partial<BacklotDesign> = {}): BacklotDesign => ({
  version: 1,
  round: 1,
  phase: 'waiting_user',
  waiting_user: true,
  suggest_skip: false,
  doc_file: 'design/v1.md',
  summary: 'Two-step checkout design.',
  questions: [{ id: 'Q1', prompt: 'Enable Stripe Link?', recommendation: 'Yes', section_ref: '§R1.P' }],
  ...more,
})
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
  localStorage.removeItem('sessionTab')
  allSessionsState.value = { ok: false, workspaces: [], panes: [] }
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

it('sends the machine session on studio actions and opens the terminal of that session', async () => {
  const secKey = 'cafecafecafecafe'
  allSessionsState.value = {
    ok: true,
    ready: true,
    workspaces: [],
    panes: [
      { id: 'w1:p1', coreAddress: 't1', session: 'default', status: 'idle', agent: 'claude', workspace: 'w1', tab: 'w1:t1', tabLabel: null, name: null, label: null, title: null, cwd: null, agentSession: null },
      { id: `s${secKey}~w1:p1`, coreAddress: 't1', session: 'acme-shop', status: 'working', agent: 'claude', workspace: `s${secKey}~w1`, tab: `s${secKey}~w1:t1`, tabLabel: null, name: null, label: null, title: null, cwd: null, agentSession: null },
    ],
    sessions: [
      { key: '', name: 'default', primary: true, status: 'online' },
      { key: secKey, name: 'acme-shop', primary: false, status: 'online' },
    ],
  }
  pickSessionTab(secKey)
  const s = studio({ roles: [role({ terminal: 't1', attention: 'permission prompt', attention_seq: 3 })] })
  const m = machine({ session: secKey, summary: { schema: 'backlot/1', updated_ms: 1, studios: [s], hollywood: { state: 'live', cards: [{ id: 'c5', studio: 'shop', action: 'merge', why: 'green' }] } } } as Partial<BacklotMachineView>)
  await mountSheet(s, m)

  await press('[data-testid="backlot-allow"]')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'approve', session: secKey, machine: '', studio: 'shop', person: 'alice', decision: 'allow' }))

  await press('[data-testid="backlot-sheet-card-apply"]')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'card-apply', session: secKey, machine: '', cardId: 'c5' }))

  $('[data-testid="backlot-role-dev"] .bls-role-main')!.click()
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(`/a/${encodeURIComponent(`s${secKey}~w1:p1`)}`))
})

it('shows design decision in the studio sheet, Reply opens the existing producer tell form, and Sign off confirms first', async () => {
  const s = studio({
    id: 'acme-shop',
    roles: [role({ role: 'producer', name: 'producer', terminal: 'host-a/t2' })],
    design: design(),
  })
  await mountSheet(s)
  const sheet = $('[data-testid="backlot-studio-sheet"]')!
  expect(sheet.textContent).toContain('Two-step checkout design.')
  expect(sheet.textContent).toContain('Enable Stripe Link?')

  // Reply opens the existing producer Tell form in the Cast section.
  await press('[data-testid="backlot-design-reply"]')
  await wait('[data-testid="backlot-role-producer"] [data-testid="backlot-tell-send"]')
  await type('[data-testid="backlot-role-producer"] input', 'Proceed with Stripe Link')
  await press('[data-testid="backlot-role-producer"] [data-testid="backlot-tell-send"]')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({
    kind: 'tell', machine: '', studio: 'acme-shop', role: 'producer', text: 'Proceed with Stripe Link',
  }))

  // Sign off confirmation: cancel sends nothing; confirm sends design-sign.
  await press('[data-testid="backlot-design-sign"]')
  expect($('[data-testid="backlot-design-confirm"]')?.textContent).toContain('design/v1-final.md')
  const before = posts.length
  await press('[data-testid="backlot-design-confirm-cancel"]')
  expect($('[data-testid="backlot-design-confirm"]')).toBeNull()
  expect(posts).toHaveLength(before)

  await press('[data-testid="backlot-design-sign"]')
  await press('[data-testid="backlot-design-confirm-submit"]')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'design-sign', machine: '', studio: 'acme-shop', skip: false }))
})

it('shows upgrade banner and disables studio actions when needs_upgrade is true', async () => {
  const s = studio({
    id: 'acme-shop',
    needs_upgrade: true,
    unknown_kinds: ['design.v2'],
    roles: [role({ attention: 'permission prompt', attention_seq: 9 })],
    design: design(),
  })
  await mountSheet(s)
  expect($('[data-testid="backlot-upgrade-banner"]')?.textContent?.toLowerCase()).toContain('upgrade backlot')
  expect($<HTMLButtonElement>('[data-testid="backlot-allow"]')?.disabled).toBe(true)
  expect($<HTMLButtonElement>('[data-testid="backlot-deny"]')?.disabled).toBe(true)
  expect($<HTMLButtonElement>('[data-testid="backlot-clear"]')?.disabled).toBe(true)
  expect($<HTMLButtonElement>('[data-testid="backlot-role-tell"]')?.disabled).toBe(true)
  expect($<HTMLButtonElement>('[data-testid="backlot-design-sign"]')?.disabled).toBe(true)
})
