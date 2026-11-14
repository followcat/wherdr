import fs from 'node:fs'
import { expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AppSheet from '~/components/AppSheet.vue'

// Opening a sheet moves focus to the sheet itself, which draws no outline,
// not to its full-width handle or first button (a blue line on iPhone).
it('focuses the outline-free sheet on open, not its handle', async () => {
  const w = await mountSuspended(AppSheet, { props: { open: true, title: 'A task' }, slots: { default: () => 'Body' }, attachTo: document.body })
  await vi.waitFor(() => expect(document.activeElement?.classList.contains('hw-sheet')).toBe(true))
  expect(document.activeElement?.getAttribute('role')).toBe('dialog')
  expect(fs.readFileSync('app/assets/css/main.css', 'utf8')).toMatch(/^\.hw-sheet:focus \{ outline: none; \}/m)
  w.unmount()
})
