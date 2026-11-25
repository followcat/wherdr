import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ProjectSheet from '~/components/ProjectSheet.vue'
import type { Project } from '#shared/pm/project'

const project = { key: 'API', name: 'acme-api', machine: '', path: '~/project', base: 'main', addedAt: 1 } as Project
afterEach(() => { vi.unstubAllGlobals() })

it('closes from the close cross, shown beside the options menu', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ workflow: null, log: [] }), { headers: { 'content-type': 'application/json' } })))
  const w = await mountSuspended(ProjectSheet, { props: { project, tab: 'general' }, global: { stubs: { ProjectMachines: true, ProjectShownIn: true } }, attachTo: document.body })
  try {
    const close = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('.hw-sheet-close')
      expect(el).not.toBeNull()
      return el!
    })
    expect(close.previousElementSibling?.querySelector('.space-menu')).not.toBeNull()
    close.click()
    await vi.waitFor(() => expect(w.emitted('close')).toHaveLength(1))
  } finally { w.unmount() }
})
