// The project sheet's "Other projects this coordinator may act on": only the
// reached projects show; Add puts a picked one at Read; remove sets it Off.
import { expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ProjectReach from '~/components/ProjectReach.vue'
import type { Project } from '#shared/pm/project'

const projects = [
  { key: 'API', name: 'Api', color: 'blue' },
  { key: 'WEB', name: 'Web', color: 'green' },
  { key: 'DOC', name: 'Docs' },
] as Project[]

it('lists only the reached projects, adds one at Read and removes one', async () => {
  let reach: Record<string, string> = { WEB: 'act' }
  const w = await mountSuspended(ProjectReach, {
    props: { projects, modelValue: reach, 'onUpdate:modelValue': (v: Record<string, string>) => { reach = v; w.setProps({ modelValue: v }) } },
    attachTo: document.body,
  })
  try {
    const rows = () => w.findAll('[data-testid="pm-reach-row"]').map(x => x.text())
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toContain('Web')

    await w.get('[data-testid="pm-reach-add"]').trigger('click')
    await vi.waitFor(() => expect(document.querySelector('[data-testid="pm-reach-pick"]')).not.toBeNull())
    expect(document.querySelector('[data-testid="pm-reach-pick-WEB"]')).toBeNull()
    ;(document.querySelector('[data-testid="pm-reach-pick-API"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(reach).toEqual({ WEB: 'act', API: 'read' }))
    await vi.waitFor(() => expect(rows()).toHaveLength(2))

    await w.get('[data-testid="pm-reach-remove-WEB"]').trigger('click')
    expect(reach).toEqual({ API: 'read' })
    await w.get('[data-testid="pm-reach-remove-API"]').trigger('click')
    expect(reach).toEqual({})
    await vi.waitFor(() => expect(w.find('[data-testid="pm-reach-none"]').text()).toBe('This coordinator acts on its own project only.'))
  } finally { w.unmount() }
})
