import { afterEach, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PhoneIdentity from '~/components/PhoneIdentity.vue'
import { herdrState } from '~/composables/useHerdr'
import type { Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'omp', name: 'build review', label: null, status: 'idle', title: '', cwd: '/', agentSession: null }
afterEach(() => { herdrState.value = { ok: false, panes: [], workspaces: [] } })
it('uses the pane name and the app state square in its two-line identity', async () => {
  herdrState.value = { ok: true, panes: [pane], workspaces: [] }
  const wrapper = await mountSuspended(PhoneIdentity, { props: { pane } })
  try {
    expect(wrapper.find('.phone-identity-title').text()).toBe('build review')
    expect(wrapper.find('.phone-identity-meta .pill.idle i').exists()).toBe(true)
    expect(wrapper.find('.phone-identity-kind').text()).toBe('OMP')
    expect(wrapper.find('[class*=circle]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'AppSheet' }).props('hideClose')).toBe(true)
    await wrapper.setProps({ pane: { ...pane, agent: null } })
    expect(wrapper.find('.phone-identity-meta').text()).toBe('Shell')
    expect(wrapper.find('.phone-identity-kind').exists()).toBe(false)
  } finally { wrapper.unmount() }
})

it('reads a herdr-core terminal without a status as the home does: Ready agent, stateless shell', async () => {
  const shell: Pane = { ...pane, coreAddress: 't5', agent: null, name: null, status: 'unknown' }
  herdrState.value = { ok: true, panes: [shell], workspaces: [] }
  const wrapper = await mountSuspended(PhoneIdentity, { props: { pane: shell } })
  try {
    expect(wrapper.find('.phone-identity-meta').text()).toBe('')
    expect(wrapper.find('.phone-identity-meta .pill').exists()).toBe(false)
    await wrapper.setProps({ pane: { ...shell, agent: 'claude' } })
    expect(wrapper.find('.phone-identity-meta .pill.idle').text()).toBe('Ready')
  } finally { wrapper.unmount() }
})

it('titles an unnamed agent pane by its agent id, without a capital or a repeated kind', async () => {
  const unnamed = { ...pane, name: '' }
  herdrState.value = { ok: true, panes: [unnamed], workspaces: [] }
  const wrapper = await mountSuspended(PhoneIdentity, { props: { pane: unnamed } })
  try {
    expect(wrapper.find('.phone-identity-title').text()).toBe('omp')
    expect(wrapper.find('.phone-identity-kind').exists()).toBe(false)
    expect(wrapper.find('.phone-identity-meta').text()).not.toMatch(/omp/i)
  } finally { wrapper.unmount() }
})

const ws = { id: 'w1', label: 'api', number: 1, status: null, worktree: false }
const tab = (id: string, number: number, label: string) => ({ id, workspace: 'w1', label, number, layout: null })
function sheetText(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  return [...document.querySelectorAll('.phone-identity-details .menu > *')].map(el => el.textContent!.trim())
}
async function openSheet(p: Pane) {
  const wrapper = await mountSuspended(PhoneIdentity, { props: { pane: p, workspace: ws }, attachTo: document.body })
  await wrapper.find('.phone-identity').trigger('click')
  await new Promise(r => setTimeout(r, 0))
  return wrapper
}
const solo = { ...pane, name: 'solo' }

it('keeps creation and renaming in the sheet of a lone pane, without a 1/1 count or one-entry lists', async () => {
  herdrState.value = { ok: true, panes: [solo], workspaces: [ws], tabs: [tab('w1:t1', 1, 'main')] }
  const wrapper = await openSheet(solo)
  try {
    expect(wrapper.find('.phone-identity-position').exists()).toBe(false)
    expect(wrapper.find('.phone-identity-chevron').exists()).toBe(true)
    expect(wrapper.find('.phone-identity').attributes('aria-label')).not.toMatch(/1\/1/)
    const current = document.querySelector('.phone-identity-details .phone-identity-current')!
    expect(current.querySelector('.phone-identity-current-title')!.textContent).toBe('solo')
    expect(current.querySelector('.pill.idle')).not.toBeNull()
    const items = sheetText(wrapper)
    expect(items).not.toContain('Panes in this tab')
    expect(items).not.toContain('Tabs')
    expect(items).not.toContain('Tab overview')
    expect(items.slice(0, 4)).toEqual(['Current pane', 'Rename pane', expect.stringMatching(/^Copy pane ID/), 'Close this conversation'])
    // A single close action: closing the lone pane closes its space (said in the confirmation).
    expect(items.slice(4)).toEqual(['Current tab', 'New tab'])
    expect(items.filter(x => /close/i.test(x))).toEqual(['Close this conversation'])
  } finally { wrapper.unmount() }
})

it('lists the panes and tabs to switch to, then the current pane and tab actions once each', async () => {
  const second = { ...pane, id: 'w1:p2', name: 'tests' }
  const other = { ...pane, id: 'w1:p3', tab: 'w1:t2', name: 'docs' }
  herdrState.value = { ok: true, panes: [solo, second, other], workspaces: [ws], tabs: [tab('w1:t1', 1, 'main'), tab('w1:t2', 2, 'notes')] }
  const wrapper = await openSheet(solo)
  try {
    expect(wrapper.find('.phone-identity-position').text()).toBe('1/2')
    expect(document.querySelector('.phone-identity-details .phone-identity-current')).toBeNull()
    const items = sheetText(wrapper)
    expect(items.indexOf('Panes in this tab')).toBe(0)
    expect(items.indexOf('Tabs')).toBeLessThan(items.indexOf('Current pane'))
    expect(items.indexOf('Current pane')).toBeLessThan(items.indexOf('Current tab'))
    expect(items.slice(items.indexOf('Current tab'))).toEqual(['Current tab', 'New tab', expect.stringMatching(/^Tab overview/)])
    // herdr-core closes panes only: no tab or space close here.
    expect(items.filter(x => /^Close/.test(x))).toEqual(['Close this conversation'])
    for (const label of ['Rename pane', 'New tab']) expect(items.filter(x => x === label)).toHaveLength(1)
    expect(items.filter(x => x.startsWith('Copy pane ID'))).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it('labels the close of a shell pane as its terminal, the same action in both views', async () => {
  const sh = { ...solo, agent: null, name: 'build' }
  const other = { ...pane, id: 'w1:p2', tab: 'w1:t2', name: 'docs' }
  herdrState.value = { ok: true, panes: [sh, other], workspaces: [ws], tabs: [tab('w1:t1', 1, 'main'), tab('w1:t2', 2, 'notes')] }
  const wrapper = await openSheet(sh)
  try {
    const items = sheetText(wrapper)
    expect(items.filter(x => /^Close/.test(x))).toEqual(['Close this terminal'])
  } finally { wrapper.unmount() }
})
