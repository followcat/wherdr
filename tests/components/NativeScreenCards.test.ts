import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ChoicesPanel from '~/components/ChoicesPanel.vue'
import { eventsOpen } from '~/composables/useHerdr'
import { screenChoices, ompActiveTab } from '../../server/utils/choices'
import type { Pane } from '#shared/types'

const { nav } = vi.hoisted(() => ({ nav: vi.fn(async () => false) }))
mockNuxtImport('navKey', () => nav)
const cases = [
  ['claude-ask-long.txt', 'claude', '.choices-list'],
  ['claude-ask-multi.txt', 'claude', '.choices-list.multi'],
  ['claude-ask-tabs-1.txt', 'claude', '.choices-list'],
  ['omp-ask-single.txt', 'omp', '.choices-list'],
  ['omp-ask-multi.txt', 'omp', '.choices-list.multi'],
  ['omp-ask-tabs.ansi', 'omp', '.choices-tabs'],
  ['claude-security-guide.txt', 'claude', '.choices'],
  ['codex-approve-edits.txt', 'codex', '.choices-list'],
] as const

afterEach(() => { eventsOpen.value = false })
it.each(cases)('renders the native card for %s', async (file, agent, selector) => {
  eventsOpen.value = true
  const raw = readFileSync(`tests/fixtures/${file}`, 'utf8')
  const text = raw.replace(/\x1b\[[0-9;]*m|\r/g, '')
  const prompt = screenChoices(text, agent)
  if (prompt?.tabs) prompt.tab = ompActiveTab(raw, prompt.tabs) ?? undefined
  expect(prompt).toBeTruthy()
  const w = await mountSuspended(ChoicesPanel, { props: { paneId: 'w1:p1', prompt } })
  expect(w.find(selector).exists() || w.element.matches(selector)).toBe(true)
  expect(w.text()).toContain(prompt?.question ?? '')
  if (file === 'omp-ask-multi.txt') {
    expect(prompt!.identity).toEqual(expect.any(String))
    await w.find('.choices-next').trigger('click')
    expect(nav).toHaveBeenCalledExactlyOnceWith('w1:p1', 'enter', prompt!.identity)
  }
  w.unmount()
})

// Card keyboard and focused fields: the empty message field lets Enter reach the
// card, while a field that handles a key itself (conversation search: Esc closes
// it) keeps it.
it('takes Enter from the empty message field, never a key a focused field handled', async () => {
  const Composer = (await import('~/components/Composer.vue')).default
  const { desk, herdrState } = await import('~/composables/useHerdr')
  eventsOpen.value = true
  desk.value = true
  nav.mockClear()
  const prompt = screenChoices(readFileSync('tests/fixtures/claude-security-guide.txt', 'utf8').replace(/\x1b\[[0-9;]*m|\r/g, ''), 'claude')!
  const pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'blocked', title: null, cwd: '/tmp/demo', agentSession: null, prompt } as Pane
  herdrState.value = { ok: true, workspaces: [], panes: [pane] }
  const card = await mountSuspended(ChoicesPanel, { props: { paneId: 'w1:p1', prompt, keys: true }, attachTo: document.body })
  const composer = await mountSuspended(Composer, { props: { pane, paneId: 'w1:p1', sendKeys: async () => {} }, attachTo: document.body })
  const search = document.createElement('input')
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') e.preventDefault() })
  document.body.append(search)
  try {
    const ta = composer.find('textarea').element as HTMLTextAreaElement
    ta.focus()
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    ta.dispatchEvent(enter)
    expect(nav).toHaveBeenCalledExactlyOnceWith('w1:p1', 'enter', prompt.identity)
    expect(enter.defaultPrevented).toBe(true)
    nav.mockClear()
    search.focus()
    for (const key of ['Escape', 'Enter']) search.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    expect(nav).not.toHaveBeenCalled()
    // No card: Enter in the empty field adds no newline and sends nothing.
    card.unmount()
    ta.focus()
    const alone = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    ta.dispatchEvent(alone)
    expect(alone.defaultPrevented).toBe(true)
    expect(nav).not.toHaveBeenCalled()
  } finally {
    search.remove()
    card.unmount()
    composer.unmount()
    desk.value = false
    herdrState.value = { ok: false, workspaces: [], panes: [] }
  }
})

// Dismiss: one tap sends Esc, as the keyboard's Escape.
it('sends Esc when Dismiss is clicked', async () => {
  eventsOpen.value = true
  nav.mockClear()
  const prompt = screenChoices(readFileSync('tests/fixtures/codex-approve-edits.txt', 'utf8').replace(/\x1b\[[0-9;]*m|\r/g, ''), 'codex')!
  const w = await mountSuspended(ChoicesPanel, { props: { paneId: 'w1:p1', prompt } })
  await w.find('.choices-dismiss').trigger('click')
  expect(nav).toHaveBeenCalledExactlyOnceWith('w1:p1', 'esc', prompt.identity)
  w.unmount()
})
