// WHR-99: a project's key badge takes its color's theme token (a plain chip
// without one), and the copy badge copies its text with a toast, without
// the tap reaching the card or row around it.
import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ProjectBadge from '~/components/ProjectBadge.vue'

const { toastFn } = vi.hoisted(() => ({ toastFn: vi.fn() }))
mockNuxtImport('toast', () => toastFn)
afterEach(() => { toastFn.mockReset(); vi.unstubAllGlobals() })

it('takes its color token, and is a plain chip without a color', async () => {
  const w = await mountSuspended(ProjectBadge, { props: { text: 'WHR', color: 'teal' } })
  expect(w.text()).toBe('WHR')
  expect(w.attributes('style')).toContain('--key-c: var(--project-teal, var(--teal))')
  expect(w.attributes('role')).toBeUndefined() // not a control
  const plain = await mountSuspended(ProjectBadge, { props: { text: 'WHR' } })
  expect(plain.attributes('style')).toBeUndefined()
})

it('copies the task id with a toast, and the card under it does not open', async () => {
  const writeText = vi.fn(() => Promise.resolve())
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  const opened = vi.fn()
  const Card = defineComponent(() => () => h('button', { onClick: opened }, [h(ProjectBadge, { text: 'WHR-52', color: 'violet', copy: true })]))
  const w = await mountSuspended(Card)
  await w.find('[data-testid="project-badge"]').trigger('click')
  await vi.waitFor(() => expect(toastFn).toHaveBeenCalledWith('Copied: WHR-52'))
  expect(writeText).toHaveBeenCalledWith('WHR-52')
  expect(opened).not.toHaveBeenCalled()
})
