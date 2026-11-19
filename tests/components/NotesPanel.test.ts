// WHR-470: leaving the conversation for a page without the panel (the board)
// hides Notes instead of turning it into a sheet; it comes back beside the
// next conversation. Only an explicit open shows the sheet.
import { afterEach, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { useRouter } from '#app'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import NotesPanel from '~/components/NotesPanel.vue'
import { sidePanelRoom } from '~/composables/useHerdr'
import { notesAway, notesOpen, toggleNotes } from '~/composables/useNotes'

registerEndpoint('/api/notes', () => ({ notes: [], files: [] }))
const stubs = { NotesList: true, SidePanelHandle: true, AppSheet: { props: ['open'], template: '<div v-if="open" data-testid="notes-sheet"><slot /></div>' } }
const mount = () => mountSuspended(NotesPanel, { route: '/a/w1:p1', global: { stubs } })
const shown = (w: Awaited<ReturnType<typeof mount>>) => ({ panel: w.find('[data-testid="notes-panel"]').exists(), sheet: w.find('[data-testid="notes-sheet"]').exists() })

afterEach(() => { notesOpen.value = false; notesAway.value = false; sidePanelRoom.value = false })

it('the board hides the open panel (no sheet); back to a conversation shows it again', async () => {
  sidePanelRoom.value = true
  notesOpen.value = true
  const w = await mount()
  const router = useRouter()
  try {
    expect(shown(w)).toEqual({ panel: true, sheet: false })
    await router.push('/board')
    await nextTick()
    expect(shown(w)).toEqual({ panel: false, sheet: false })
    expect(notesOpen.value).toBe(true)
    await router.push('/a/w1:p1')
    await nextTick()
    expect(shown(w)).toEqual({ panel: true, sheet: false })
  } finally { w.unmount() }
})

it('no room for the panel: an explicit open shows the sheet', async () => {
  const w = await mount()
  try {
    toggleNotes()
    await nextTick()
    expect(shown(w)).toEqual({ panel: false, sheet: true })
  } finally { w.unmount() }
})
