import { expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { flushPromises } from '@vue/test-utils'
import TemplateLibrary from '~/components/TemplateLibrary.vue'
import { vibe } from '#shared/pm/examples'
import { answerConfirm, confirmState, menuState } from '~/composables/useUi'

const posts: { url: string, body: unknown }[] = []
registerEndpoint('/api/pm/template', () => ({ template: { ...vibe, id: 'team', version: 3 }, log: [] }))
for (const url of ['/api/pm/template-rename', '/api/pm/template-remove']) {
  registerEndpoint(url, { method: 'POST', handler: async (e) => { posts.push({ url, body: await readBody(e) }); return {} } })
}
const $ = (sel: string) => document.body.querySelector<HTMLElement>(sel)
const $$ = (sel: string) => [...document.body.querySelectorAll<HTMLElement>(sel)].map(e => e.dataset.id)
const item = (label: string) => menuState.items.find(i => 'label' in i && i.label.startsWith(label)) as { run: () => void }

it('lists saved templates and the examples they do not shadow; a saved one is read, renamed and deleted', async () => {
  const w = await mountSuspended(TemplateLibrary, { props: { open: true, templates: [{ id: 'team', version: 3 }, { id: 'vibe', version: 1 }] } })
  await flushPromises()
  expect($$('[data-testid="library-saved"]')).toEqual(['team', 'vibe'])
  expect($$('[data-testid="library-example"]')).not.toContain('vibe')

  // An example: read only, no menu.
  $('[data-testid="library-example"][data-id="company"]')!.click()
  await vi.waitFor(() => expect($('[data-testid="library-json"]')?.textContent).toContain('"company"'))
  expect($('[data-testid="template-library"] .space-menu')).toBeNull()
  $('[data-testid="library-back"]')!.click()
  await flushPromises()

  $('[data-testid="library-saved"][data-id="team"]')!.click()
  await vi.waitFor(() => expect($('[data-testid="library-plan"]')?.textContent).toContain('Plan of a simple task'))
  $('[data-testid="template-library"] .space-menu')!.click()
  item('Rename').run()
  await flushPromises()
  const input = $('[data-testid="library-new-id"] input, input[data-testid="library-new-id"]') as HTMLInputElement
  input.value = 'crew'
  input.dispatchEvent(new Event('input'))
  await flushPromises()
  $('[data-testid="library-rename"]')!.click()
  await vi.waitFor(() => expect(posts).toEqual([{ url: '/api/pm/template-rename', body: { id: 'team', to: 'crew' } }]))
  await vi.waitFor(() => expect(w.emitted('changed')).toHaveLength(1))
  await flushPromises()

  $('[data-testid="library-saved"][data-id="team"]')!.click()
  await vi.waitFor(() => expect($('[data-testid="library-json"]')).not.toBeNull())
  $('[data-testid="template-library"] .space-menu')!.click()
  item('Delete').run()
  await vi.waitFor(() => expect(confirmState.message).toContain('keep their own workflow'))
  answerConfirm(true)
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/pm/template-remove', body: { id: 'team' } }))
  w.unmount()
})
