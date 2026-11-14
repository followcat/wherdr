import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery } from 'h3'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import NotesList from '~/components/NotesList.vue'
import { noteFiles, notes, notesFilter } from '~/composables/useNotes'
import { machineBarSaved, machineGroups } from '~/composables/useMachineBar'
import { NOTES_FOLLOW, type Note } from '#shared/notes'
import { pick } from '../helpers/select'

const note = (id: string, scope: string, body: string): Note => ({ id, title: id, scope, body, created: '', updated: '' })
afterEach(() => { notes.value = null; noteFiles.value = null; notesFilter.value = NOTES_FOLLOW; machineGroups.value = []; machineBarSaved.value = null })

it('follows the tab, renders badges and keeps checkboxes read-only', async () => {
  machineGroups.value = [{ id: 'g1', name: 'Work', machines: ['host-a'] }, { id: 'g2', name: 'Home', machines: ['host-b'] }]
  machineBarSaved.value = 'g1'
  notes.value = [
    note('everywhere', 'all', '- [ ] Review [[WHR-12]]\n- [x] Ship it'),
    note('work', 'g1', 'Waiting on [[Design|clock|amber]] in `[[not-a-badge]]`'),
    note('home', 'g2', 'Water the plants'),
  ]
  const w = await mountSuspended(NotesList)
  await nextTick()
  const titles = () => w.findAll('[data-testid=note] h3 span').map(x => x.text())
  expect(titles()).toEqual(['everywhere', 'work'])

  const badges = w.findAll('[data-testid=note-badge]')
  expect(badges.map(b => b.text())).toEqual(['WHR-12', 'Design'])
  expect(badges[0]!.attributes('href')).toBe('#/board?task=WHR-12')
  expect(w.find('#note-work code').text()).toBe('[[not-a-badge]]')

  const box = w.find('#note-everywhere input[type=checkbox]')
  expect(box.attributes('disabled')).toBeDefined()
  await box.trigger('click')
  expect((box.element as HTMLInputElement).checked).toBe(false)

  machineBarSaved.value = 'g2' // the home tab changes: the notes follow
  await nextTick()
  expect(titles()).toEqual(['everywhere', 'home'])
  await pick(w, 'notes-filter', 'all')
  expect(titles()).toEqual(['everywhere', 'work', 'home'])
  w.unmount()
})

it('says which machine tab it follows, and when that tab has no note of its own', async () => {
  machineBarSaved.value = '' // the only machine, shown as its own tab
  notes.value = [note('everywhere', 'all', 'x')]
  const w = await mountSuspended(NotesList)
  await nextTick()
  expect(w.find('[data-testid=notes-following]').text()).toBe('This machine · following the tab')
  expect(w.find('[data-testid=notes-tab-empty]').text()).toBe('No notes for This machine yet')
  notes.value = [...notes.value, note('mine', 'machine:', 'y')]
  await nextTick()
  expect(w.find('[data-testid=notes-tab-empty]').exists()).toBe(false)
  expect(w.findAll('[data-testid=note]').length).toBe(2)
  w.unmount()
})

const FILES: Record<string, string> = {
  'plans/x.md': '# The plan\n\nSee [steps](steps.md), [gone](gone.md), [secret](../../outside.md) and [the note](../home.md).',
  'plans/steps.md': '# Steps\n\nBack [up](x.md).',
}
registerEndpoint('/api/notes/file', e => ({ text: FILES[String(getQuery(e).path)] ?? null }))

it('opens a linked file in place, follows its links, mutes the missing and the escaping ones, and goes back', async () => {
  notes.value = [note('home', 'all', 'The [plan](plans/x.md), a [lost one](plans/lost.md)')]
  noteFiles.value = Object.keys(FILES)
  const w = await mountSuspended(NotesList)
  await nextTick()
  const lost = w.find('#note-home a[href="plans/lost.md"]')
  expect(lost.classes()).toContain('note-link-missing')
  expect(lost.attributes('title')).toBe('This file is missing')
  await lost.trigger('click')
  await flushPromises()
  expect(w.find('[data-testid=note-file]').exists()).toBe(false)

  await w.find('#note-home a[href="plans/x.md"]').trigger('click')
  await vi.waitFor(() => expect(w.find('.note-file-body').text()).toMatch(/^The plan/))
  expect(w.find('.notes-index').attributes('style')).toContain('display: none')
  const link = (href: string) => w.find(`.note-file-body a[href="${href}"]`)
  expect(link('steps.md').classes()).not.toContain('note-link-missing') // relative: plans/steps.md
  expect(link('gone.md').attributes('title')).toBe('This file is missing')
  expect(link('../../outside.md').attributes('title')).toBe('Outside the notes folder')
  await link('../../outside.md').trigger('click')
  await flushPromises()
  expect(w.find('.note-file-body').text()).toMatch(/^The plan/) // refused: stays

  expect(link('../home.md').classes()).not.toContain('note-link-missing')
  FILES['plans/x.md'] = '# The plan, edited\n\nSee [steps](steps.md).' // an agent's change, read at the next poll
  noteFiles.value = Object.keys(FILES)
  await vi.waitFor(() => expect(w.find('.note-file-body').text()).toMatch(/^The plan, edited/))
  await link('steps.md').trigger('click')
  await vi.waitFor(() => expect(w.find('.note-file-body').text()).toMatch(/^Steps/))
  await w.find('[data-testid=note-file-back]').trigger('click')
  await nextTick()
  expect(w.find('[data-testid=note-file]').exists()).toBe(false)
  expect(w.find('.notes-index').attributes('style') ?? '').not.toContain('display: none')
  expect(w.find('#note-home a[href="plans/lost.md"]').classes()).toContain('note-link-missing') // marked from the folder again
  w.unmount()
})
