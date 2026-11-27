import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import BacklotSection from '~/components/BacklotSection.vue'
import { allSessionsState, herdrState, pickSessionTab } from '~/composables/useHerdr'
import { refreshBacklot } from '~/composables/useBacklot'
import { machineBarSaved } from '~/composables/useMachineBar'
import type { BacklotDesign, BacklotMachineView, BacklotRole, BacklotStudio } from '#shared/backlot'
import type { HerdrState, Pane } from '#shared/types'

let apiMachines: BacklotMachineView[] = []
registerEndpoint('/api/backlot', () => ({ ok: true, machines: apiMachines }))
const posts: unknown[] = []
registerEndpoint('/api/backlot/action', { method: 'POST', handler: async (event) => { posts.push(await readBody(event)); return { ok: true, output: 'done' } } })
let docResponse: { ok: boolean, file?: string, text?: string, truncated?: boolean, error?: string } = {
  ok: true,
  file: 'design/v1.md',
  text: '# Design discussion · req v1\n\n## R1\n\n### §R1.W Proposal · writer (#2)\n\nUse SQLite WAL.\n\n### §R1.D Buildability · director (#3)\n\nLooks solid.\n\n### §R1.P Summary · producer (#4)\n\nReady for sign-off.\n',
  truncated: false,
}
const docQueries: unknown[] = []
registerEndpoint('/api/backlot/doc', { method: 'GET', handler: async (event) => {
  const url = new URL(event.node.req.url || '', 'http://localhost')
  docQueries.push(Object.fromEntries(url.searchParams))
  return docResponse
} })

const role = (more: Partial<BacklotRole> = {}): BacklotRole => ({ role: 'dev', name: 'alice', state: 'live', ...more })
const design = (more: Partial<BacklotDesign> = {}): BacklotDesign => ({
  version: 1,
  round: 1,
  phase: 'waiting_user',
  waiting_user: true,
  suggest_skip: false,
  doc_file: 'design/v1.md',
  summary: 'Use SQLite WAL with explicit lease retries.',
  questions: [
    { id: 'Q1', prompt: 'Keep legacy SQLite fallback?', recommendation: 'Yes, for offline dev', section_ref: '§R1.W' },
    { id: 'Q2', prompt: 'Cap retries at 5?', recommendation: 'Yes, 30s backoff', section_ref: '§R1.D' },
  ],
  ...more,
})
const studio = (more: Partial<BacklotStudio> = {}): BacklotStudio => ({
  id: 'shop', title: 'Acme shop', state: 'live', requirement_version: 3, open_reviews: 0, waiting: 2, tasks_done: 2, tasks_total: 5, roles: [role()], ...more,
})
const view = (more: Partial<BacklotMachineView> = {}): BacklotMachineView => ({
  machine: '', label: 'host-a', stageRunning: true, backlotVersion: '1.0.0',
  summary: { schema: 'backlot/1', updated_ms: 1, studios: [studio()], hollywood: null }, ...more,
})
const pane = (id: string, session: string): Pane => ({
  id, session, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null,
  label: null, status: 'idle', title: null, cwd: '/home/user/acme-shop', agentSession: null,
})
const twoSessionsState = (secKey: string): HerdrState => ({
  ok: true,
  ready: true,
  workspaces: [],
  panes: [pane('w1:p1', 'default'), pane(`s${secKey}~w1:p1`, 'acme-shop')],
  sessions: [
    { key: '', name: 'default', primary: true, status: 'online' },
    { key: secKey, name: 'acme-shop', primary: false, status: 'online' },
  ],
})

let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
afterEach(() => {
  w?.unmount()
  w = null
  posts.length = 0
  docQueries.length = 0
  apiMachines = []
  machineBarSaved.value = null
  localStorage.removeItem('sessionTab')
  allSessionsState.value = { ok: false, workspaces: [], panes: [] }
  herdrState.value = { ok: false, workspaces: [], panes: [] }
  document.body.innerHTML = ''
})

it('renders nothing when no machine publishes a backlot document', async () => {
  w = await mountSuspended(BacklotSection, { props: { machines: [] } })
  expect(w.find('[data-testid="backlot-section"]').exists()).toBe(false)
})

it('shows the studios, progress, waiting count and a stopped stage, then starts it', async () => {
  w = await mountSuspended(BacklotSection, { props: { machines: [view({ stageRunning: false })] }, attachTo: document.body })
  const section = w.find('[data-testid="backlot-section"]')
  expect(section.exists()).toBe(true)
  expect(section.find('.group-title').text()).toContain('Studios')
  expect(section.find('[data-testid="backlot-waiting"]').text()).toBe('2')
  const card = section.find('[data-testid="backlot-studio-local-shop"]')
  expect(card.text()).toContain('Acme shop')
  expect(card.text()).toContain('r3 · 2/5')
  expect(card.text()).toContain('2 waiting')
  expect(section.find('[data-testid="backlot-stage-notice"]').text()).toContain('Stage not running')
  await section.find('[data-testid="backlot-stage-start"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ kind: 'stage-start', machine: '' }]))
})

it('opens the studio sheet from its card', async () => {
  w = await mountSuspended(BacklotSection, { props: { machines: [view()] }, attachTo: document.body })
  await w.find('[data-testid="backlot-studio-local-shop"]').trigger('click')
  await vi.waitFor(() => expect(document.body.querySelector('[data-testid="backlot-studio-sheet"]')).not.toBeNull())
})

it('keeps one card per machine and follows the machine bar filter', async () => {
  herdrState.value = {
    ok: true, workspaces: [], panes: [],
    machines: [
      { key: '', label: 'host-a', local: true, status: 'online', error: null },
      { key: '6b', label: 'host-b', local: false, status: 'online', error: null },
      { key: '6c', label: 'host-c', local: false, status: 'online', error: null },
    ],
  }
  const machines = [
    view({ machine: 'host-b', label: 'host-b', summary: { schema: 'backlot/1', updated_ms: 1, studios: [studio({ id: 'beta', title: 'Beta tools' })], hollywood: null } }),
    view({ machine: 'host-c', label: 'host-c', summary: { schema: 'backlot/1', updated_ms: 1, studios: [studio({ id: 'gamma', title: 'Gamma' })], hollywood: null } }),
  ]
  machineBarSaved.value = '6b'
  w = await mountSuspended(BacklotSection, { props: { machines }, attachTo: document.body })
  expect(w.findAll('[data-testid^="backlot-studio-"]').map(c => c.text())).toEqual([expect.stringContaining('Beta tools')])
  expect(w.find('[data-testid="backlot-studio-host-b-beta"]').exists()).toBe(true)
  expect(w.find('[data-testid="backlot-studio-host-c-gamma"]').exists()).toBe(false)
  machineBarSaved.value = '*'
  await vi.waitFor(() => expect(w!.findAll('[data-testid^="backlot-studio-"]')).toHaveLength(2))
})

it('shows Hollywood cards and tells Hollywood from the section', async () => {
  const machine = view({
    summary: {
      schema: 'backlot/1', updated_ms: 1, studios: [studio()],
      hollywood: { state: 'live', headline: 'Ship it', cards: [{ id: 'c1', studio: 'shop', action: 'merge', why: 'ready' }] },
    },
  })
  w = await mountSuspended(BacklotSection, { props: { machines: [machine] }, attachTo: document.body })
  const holly = w.find('[data-testid="backlot-hollywood-local"]')
  expect(holly.text()).toContain('Ship it')
  expect(holly.text()).toContain('1 open cards')
  await holly.find('[data-testid="backlot-card-apply"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ kind: 'card-apply', machine: '', cardId: 'c1' }]))
  await holly.find('[data-testid="backlot-tell-hollywood"]').trigger('click')
  await holly.find('input').setValue('Focus on checkout')
  await holly.find('[data-testid="backlot-tell-hollywood-send"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([
    { kind: 'card-apply', machine: '', cardId: 'c1' },
    { kind: 'tell-hollywood', machine: '', text: 'Focus on checkout' },
  ]))
})

it('shows only the selected session tab documents and sends the session with every action', async () => {
  const secKey = 'cafecafecafecafe'
  allSessionsState.value = twoSessionsState(secKey)
  pickSessionTab('')

  const machines: BacklotMachineView[] = [
    view({
      session: '',
      summary: {
        schema: 'backlot/1', updated_ms: 1, studios: [],
        hollywood: { state: 'live', headline: 'empty lot — no studios, no cards; watching', cards: [] },
      },
    } as Partial<BacklotMachineView>),
    view({
      session: secKey,
      summary: {
        schema: 'backlot/1', updated_ms: 2,
        studios: [studio({ id: 'shop', title: 'Acme shop' })],
        hollywood: { state: 'live', headline: '5 active studios', cards: [{ id: 'c2', studio: 'shop', action: 'merge', why: 'all checks green' }] },
      },
    } as Partial<BacklotMachineView>),
  ]

  apiMachines = machines
  await refreshBacklot()
  w = await mountSuspended(BacklotSection, { attachTo: document.body })

  // Default session tab shows its own Hollywood card and no Acme shop studio.
  await vi.waitFor(() => expect(w!.text()).toContain('empty lot'))
  expect(w.text()).not.toContain('Acme shop')
  expect(w.text()).not.toContain('5 active studios')

  // Switching to the acme-shop session tab switches studios, Hollywood and Tell Hollywood.
  pickSessionTab(secKey)
  await vi.waitFor(() => expect(w!.text()).toContain('Acme shop'))
  expect(w.text()).toContain('5 active studios')
  expect(w.text()).not.toContain('empty lot')

  await w.find('[data-testid="backlot-card-apply"]').trigger('click')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'card-apply', session: secKey, machine: '', cardId: 'c2' }))

  await w.find('[data-testid="backlot-tell-hollywood"]').trigger('click')
  await w.find('[data-testid="backlot-hollywood-local"] input').setValue('Focus on checkout')
  await w.find('[data-testid="backlot-tell-hollywood-send"]').trigger('click')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'tell-hollywood', session: secKey, machine: '', text: 'Focus on checkout' }))

  // Opening the studio sheet acts on the selected session, and switching tabs closes it.
  await w.find('[data-testid="backlot-studio-local-shop"]').trigger('click')
  await vi.waitFor(() => expect(document.body.querySelector('[data-testid="backlot-studio-sheet"]')).not.toBeNull())
  await document.body.querySelector<HTMLButtonElement>('[data-testid="backlot-role-dev"] [data-testid="backlot-role-tell"]')!.click()
  await vi.waitFor(() => expect(document.body.querySelector('[data-testid="backlot-tell-send"]')).not.toBeNull())
  const tellInput = document.body.querySelector<HTMLInputElement>('[data-testid="backlot-role-dev"] input')!
  tellInput.value = 'Check status'
  tellInput.dispatchEvent(new Event('input'))
  await vi.waitFor(() => expect(document.body.querySelector<HTMLButtonElement>('[data-testid="backlot-tell-send"]')?.disabled).toBe(false))
  document.body.querySelector<HTMLButtonElement>('[data-testid="backlot-tell-send"]')!.click()
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'tell', session: secKey, machine: '', studio: 'shop', role: 'dev', text: 'Check status' }))

  pickSessionTab('')
  await vi.waitFor(() => expect(w!.text()).toContain('empty lot'))
  expect(document.body.querySelector('[data-testid="backlot-studio-sheet"]')).toBeNull()
})

it('renders waiting_user decision block, reads the doc with jumpable headings, replies, and confirms sign off (cancel sends nothing)', async () => {
  const m = view({
    summary: { schema: 'backlot/1', updated_ms: 1, studios: [studio({ id: 'acme-shop', title: 'Acme shop', waiting: 0, design: design() })], hollywood: null },
  })
  w = await mountSuspended(BacklotSection, { props: { machines: [m] }, attachTo: document.body })
  const card = w.find('[data-testid="backlot-studio-local-acme-shop"]')
  const decision = card.find('[data-testid="backlot-design-decision"]')
  expect(decision.exists()).toBe(true)
  expect(decision.text()).toContain('R1')
  expect(decision.text()).toContain('Use SQLite WAL with explicit lease retries.')
  expect(decision.text()).toContain('Q1')
  expect(decision.text()).toContain('Keep legacy SQLite fallback?')
  expect(decision.text()).toContain('Yes, for offline dev')
  expect(decision.text()).toContain('§R1.W')
  expect(decision.find('[data-testid="backlot-design-read"]').exists()).toBe(true)
  expect(decision.find('[data-testid="backlot-design-reply"]').exists()).toBe(true)
  expect(decision.find('[data-testid="backlot-design-sign"]').exists()).toBe(true)

  // Read opens the design doc sheet with jumpable R<r> and §R<r>.<W|D|P|U> headings.
  await decision.find('[data-testid="backlot-design-read"]').trigger('click')
  await vi.waitFor(() => expect(document.body.querySelector('[data-testid="backlot-design-doc-sheet"]')).not.toBeNull())
  expect(docQueries.at(-1)).toMatchObject({ studio: 'acme-shop', file: 'design/v1.md' })
  const docSheet = document.body.querySelector('[data-testid="backlot-design-doc-sheet"]')!
  await vi.waitFor(() => expect(docSheet.textContent).toContain('Use SQLite WAL.'))
  const jumps = [...docSheet.querySelectorAll('[data-testid="backlot-design-jump"]')].map(el => el.textContent)
  expect(jumps.some(t => t?.includes('R1'))).toBe(true)
  expect(jumps.some(t => t?.includes('§R1.W'))).toBe(true)
  expect(jumps.some(t => t?.includes('§R1.D'))).toBe(true)
  expect(jumps.some(t => t?.includes('§R1.P'))).toBe(true)
  // Close doc sheet before testing actions.
  document.body.querySelector<HTMLButtonElement>('.hw-sheet-close')?.click()
  await vi.waitFor(() => expect(document.body.querySelector('[data-testid="backlot-design-doc-sheet"]')).toBeNull())

  // Reply sends tell producer.
  await decision.find('[data-testid="backlot-design-reply"]').trigger('click')
  await decision.find('[data-testid="backlot-design-reply-form"] input').setValue('Keep WAL enabled')
  await decision.find('[data-testid="backlot-design-reply-send"]').trigger('click')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({
    kind: 'tell', machine: '', studio: 'acme-shop', role: 'producer', text: 'Keep WAL enabled',
  }))

  // Sign off asks confirmation naming mode and frozen document; Cancel sends nothing.
  await decision.find('[data-testid="backlot-design-sign"]').trigger('click')
  const confirm = decision.find('[data-testid="backlot-design-confirm"]')
  expect(confirm.exists()).toBe(true)
  expect(confirm.text().toLowerCase()).toContain('approved')
  expect(confirm.text()).toContain('design/v1-final.md')
  const countBeforeCancel = posts.length
  await confirm.find('[data-testid="backlot-design-confirm-cancel"]').trigger('click')
  expect(decision.find('[data-testid="backlot-design-confirm"]').exists()).toBe(false)
  expect(posts).toHaveLength(countBeforeCancel)

  // Confirming Sign off sends design-sign.
  await decision.find('[data-testid="backlot-design-sign"]').trigger('click')
  await decision.find('[data-testid="backlot-design-confirm-submit"]').trigger('click')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({
    kind: 'design-sign', machine: '', studio: 'acme-shop', skip: false,
  }))
})

it('renders suggest_skip with Skip (confirmed) and Discuss, quiet phase line, none, count bucket and upgrade banner', async () => {
  const skipStudio = studio({
    id: 'acme-skip',
    title: 'Acme Skip',
    waiting: 0,
    design: design({
      round: 0,
      phase: 'suggest_skip',
      suggest_skip: true,
      skip_reason: 'Typo fix in footer copy',
      summary: null,
      questions: [],
    }),
  })
  const quietStudio = studio({
    id: 'acme-quiet',
    title: 'Acme Quiet',
    waiting: 0,
    design: design({ round: 2, phase: 'waiting_proposal', waiting_user: false, summary: null, questions: [] }),
  })
  const noneStudio = studio({
    id: 'acme-none',
    title: 'Acme None',
    waiting: 1,
    roles: [role({ asks: 'Which port?' })],
    design: null,
  })
  const upgradeStudio = studio({
    id: 'acme-old',
    title: 'Acme Old',
    waiting: 0,
    needs_upgrade: true,
    unknown_kinds: ['design.v2'],
    design: design(),
  })

  const m = view({
    summary: { schema: 'backlot/1', updated_ms: 1, studios: [skipStudio, quietStudio, noneStudio, upgradeStudio], hollywood: null },
  })
  w = await mountSuspended(BacklotSection, { props: { machines: [m] }, attachTo: document.body })

  // Count bucket: blocking alarms = 1 (noneStudio.waiting), asks = 2 (1 skipStudio design + 1 noneStudio role.asks; quietStudio=0, upgradeStudio=0).
  expect(w.find('[data-testid="backlot-waiting"]').text()).toBe('1')
  expect(w.find('[data-testid="backlot-asks"]').text()).toContain('2')

  // suggest_skip card
  const skipCard = w.find('[data-testid="backlot-studio-local-acme-skip"]')
  expect(skipCard.text().toLowerCase()).toContain('skip suggested')
  expect(skipCard.text()).toContain('Typo fix in footer copy')
  expect(skipCard.find('[data-testid="backlot-design-skip"]').exists()).toBe(true)
  expect(skipCard.find('[data-testid="backlot-design-discuss"]').exists()).toBe(true)
  await skipCard.find('[data-testid="backlot-design-skip"]').trigger('click')
  const skipConfirm = skipCard.find('[data-testid="backlot-design-confirm"]')
  expect(skipConfirm.text().toLowerCase()).toContain('skipped')
  expect(skipConfirm.text()).toContain('design/v1.md')
  await skipConfirm.find('[data-testid="backlot-design-confirm-cancel"]').trigger('click')
  expect(posts).toEqual([])
  await skipCard.find('[data-testid="backlot-design-skip"]').trigger('click')
  await skipCard.find('[data-testid="backlot-design-confirm-submit"]').trigger('click')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'design-sign', machine: '', studio: 'acme-skip', skip: true }))
  await skipCard.find('[data-testid="backlot-design-discuss"]').trigger('click')
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'design-open', machine: '', studio: 'acme-skip' }))

  // quiet phase card
  const quietCard = w.find('[data-testid="backlot-studio-local-acme-quiet"]')
  expect(quietCard.find('[data-testid="backlot-design-status"]').text()).toBe('design · R2 · proposal')
  expect(quietCard.find('[data-testid="backlot-design-decision"]').exists()).toBe(false)

  // none card
  const noneCard = w.find('[data-testid="backlot-studio-local-acme-none"]')
  expect(noneCard.find('[data-testid="backlot-design-decision"]').exists()).toBe(false)
  expect(noneCard.find('[data-testid="backlot-design-status"]').exists()).toBe(false)

  // upgrade banner card disables actions
  const oldCard = w.find('[data-testid="backlot-studio-local-acme-old"]')
  expect(oldCard.find('[data-testid="backlot-upgrade-banner"]').text().toLowerCase()).toContain('upgrade backlot')
  for (const btn of oldCard.findAll('[data-testid="backlot-design-decision"] button')) {
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
  }
})

it('opens the studio sheet named by the home deep link', async () => {
  w = await mountSuspended(BacklotSection, { props: { machines: [view()] }, route: '/?studio=shop', attachTo: document.body })
  await vi.waitFor(() => expect(document.body.querySelector('[data-testid="backlot-studio-sheet"]')).not.toBeNull())
  await useRouter().replace('/')
})

it('opening a studio card writes its deep link, and closing the sheet clears it', async () => {
  w = await mountSuspended(BacklotSection, { props: { machines: [view()] }, route: '/', attachTo: document.body })
  await w.find('[data-testid="backlot-studio-local-shop"]').trigger('click')
  await expect.poll(() => useRouter().currentRoute.value.query.studio).toBe('shop')
  expect(document.body.querySelector('[data-testid="backlot-studio-sheet"]')).not.toBeNull()
  document.body.querySelector<HTMLButtonElement>('.hw-sheet-close')?.click()
  await vi.waitFor(() => expect(document.body.querySelector('[data-testid="backlot-studio-sheet"]')).toBeNull())
  await expect.poll(() => useRouter().currentRoute.value.query.studio).toBeUndefined()
})
