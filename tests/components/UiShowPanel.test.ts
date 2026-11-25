// WHR-544: the "Shown by the agent" panel has the Notes panel's left-edge
// handle (SidePanelHandle: its own tests cover drag, keys and reset); a task
// folder's file, given by its absolute path, is read as a written path.
import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import UiShowPanel from '~/components/UiShowPanel.vue'
import { sidePanelRoom, uiShown } from '~/composables/useHerdr'

const stubs = { FilesView: { props: ['file', 'inFolder'], template: '<div data-testid="files" :data-in-folder="String(inFolder)" />' }, UiShowShots: true }
afterEach(() => { uiShown.value = null; sidePanelRoom.value = false; document.documentElement.style.removeProperty('--settings-panel') })

it('is resizable by its left edge, and reads a task folder\'s file by its absolute path', async () => {
  sidePanelRoom.value = true
  uiShown.value = { type: 'ui-show', pane: 'p1', what: 'file', arg: 'docs/plan.md', by: 'WEB coordinator' }
  const w = await mountSuspended(UiShowPanel, { route: '/a/w1:p1', global: { stubs } })
  try {
    expect(document.querySelector('.panel-handle')?.getAttribute('aria-controls')).toBe('ui-show')
    expect(w.find('[data-testid="files"]').attributes('data-in-folder')).toBe('true')
    uiShown.value = { ...uiShown.value, arg: '/home/u/.wherdr/pm/tasks/WEB-3/report.md' }
    await w.vm.$nextTick()
    expect(w.find('[data-testid="files"]').attributes('data-in-folder')).toBe('false')
  } finally { w.unmount() }
})

// WHR-565: one Markdown file reads as a document under one header.
registerEndpoint('/api/files/read', () => ({
  path: 'docs/plan.md', size: 120, kind: 'text', truncated: false,
  text: 'Sample.\n\n# Plan\n\nCall `draft.get/set/focus`, then `npm test`.\n\n```sh\nnpm test\n```\n',
}))

it('shows a Markdown file\'s name once, its folder and controls under it, and no control on inline code', async () => {
  sidePanelRoom.value = true
  uiShown.value = { type: 'ui-show', pane: 'p1', what: 'file', arg: 'docs/plan.md', by: 'WEB coordinator' }
  // In the document: the header's controls are teleported there by its id.
  const w = await mountSuspended(UiShowPanel, { route: '/a/w1:p1', attachTo: document.body, global: { stubs: { UiShowShots: true } } })
  try {
    await flushPromises()
    await vi.waitFor(() => expect(w.find('.files-md h1').exists()).toBe(true))
    const head = w.find('.ui-show-top')
    expect(w.text().split('plan.md')).toHaveLength(2)
    expect(head.find('h2').text()).toBe('plan.md')
    expect(head.find('[data-testid="files-located"]').text()).toBe('docs · 120 B')
    expect(head.find('button[aria-label="Download"]').exists()).toBe(true)
    expect(head.find('.files-md-mode').exists()).toBe(true)
    const inline = w.findAll('.files-md p code')
    expect(inline.map(c => c.text())).toEqual(['draft.get/set/focus', 'npm test'])
    expect(inline.every(c => !c.attributes('data-k') && !c.attributes('role'))).toBe(true)
    expect(w.find('.files-md .code-copy').exists()).toBe(true)
    expect(w.find('.files-md .code-run').exists()).toBe(false)
  } finally { w.unmount() }
})
