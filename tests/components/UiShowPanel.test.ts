// WHR-544: the "Shown by the agent" panel has the Notes panel's left-edge
// handle (SidePanelHandle: its own tests cover drag, keys and reset); a task
// folder's file, given by its absolute path, is read as a written path.
import { afterEach, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
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
