import fs from 'node:fs'
import { h } from 'vue'
import { expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AppSheet from '~/components/AppSheet.vue'
import { kbOpen } from '~/composables/useViewport'

// On a phone, typing in a sheet's field hides the bars pinned over its body
// (a task's To do buttons), so the keyboard never pushes the caret under them;
// they come back on blur. A long title is clamped, whole on a tap.
it('hides the pinned bar while a field is typed in on a phone, and clamps the title', async () => {
  const mm = vi.spyOn(window, 'matchMedia').mockImplementation(q => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList)
  const w = await mountSuspended(AppSheet, {
    props: { open: true, clamp: true, title: 'A very long made-up task title '.repeat(4) },
    slots: { default: () => [h('textarea', { 'data-testid': 'note' }), h('button', { 'data-testid': 'send' }, 'Send back')] },
    attachTo: document.body,
  })
  const part = (slot: string) => document.querySelector(`.hw-sheet > [data-slot="${slot}"]`)!
  await vi.waitFor(() => expect(part('body')).toBeTruthy())
  const title = document.querySelector('[data-testid="sheet-title"]') as HTMLElement
  expect(title.classList.contains('clamp')).toBe(true)
  title.click()
  await nextTick()
  expect(title.classList.contains('open')).toBe(true)

  const note = document.querySelector('[data-testid="note"]') as HTMLTextAreaElement
  note.focus()
  await nextTick()
  expect(part('body').classList).toContain('typing')
  expect(part('header').classList).toContain('compact') // the header down to one line
  expect(title.classList.contains('open')).toBe(false)
  // The keyboard dismissed with the field still focused (Android Back), then
  // reopened by a tap on that same field: no new focusin, typing again.
  kbOpen.value = true
  await nextTick()
  kbOpen.value = false
  await nextTick()
  expect(part('body').classList).not.toContain('typing')
  kbOpen.value = true
  await nextTick()
  expect(part('body').classList).toContain('typing')
  note.blur()
  await nextTick()
  expect(part('body').classList).not.toContain('typing')
  kbOpen.value = false
  // What the classes do on the phone: the To do bar hides, the title is cut.
  expect(fs.readFileSync('app/components/TaskTodo.vue', 'utf8')).toMatch(/:global\(\.hw-sheet:has\(> \.typing\) \.todo-actions[^{]*\{ display: none; \}/)
  expect(fs.readFileSync('app/assets/css/main.css', 'utf8')).toMatch(/\.hw-sheet-title\.clamp \{[^}]*-webkit-line-clamp: 2/)
  w.unmount()
  mm.mockRestore()
})
