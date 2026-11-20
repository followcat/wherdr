// The Notes panel (NotesPanel.vue): open or not, its filter (kept on the
// server, like the Board's project picker), and the notes, read again every
// few seconds while it is open so an agent's change shows without a reload.
import { NOTES_FOLLOW, noteTabs, tabScope, type Note } from '#shared/notes'
import { syncedRef } from './useSyncedSettings'
import { readNotesPanel, saveNotesPanel } from '~/utils/notesPanel'

// Open or not, and the linked file shown (NotesList.vue), kept on the device
// and read before the first paint (utils/notesPanel.ts).
const restored = import.meta.client ? readNotesPanel(sidePanelRoom.value) : { open: false, file: '' }
export const notesOpen = ref(restored.open)
export const notesFile = ref<string | null>(restored.file || null)
watch([notesOpen, notesFile], ([open, file]) => saveNotesPanel(open, file))
export const notesFilter = syncedRef<string>('notesFilter', raw => raw || NOTES_FOLLOW, v => (v === NOTES_FOLLOW ? null : v))
export const notes = ref<Note[] | null>(null)
// The linked files' paths (plans/x.md): a link to another shows as missing.
export const noteFiles = ref<string[] | null>(null)
// The home tabs a note may be scoped to (groups and machines shown as their
// own tab), in the bar's order, and the one picked (null: every machine).
export const notesTabs = computed(() => noteTabs(machineBarItems.value.filter(x => x.shown).map(x => x.id), machineGroups.value, notesMachineName))
export const notesTab = computed(() => tabScope(machineBarPick.value, machineGroups.value))
export const notesMachineName = (key: string) => machineName(key) || key || t('This machine')

export const loadNotes = () => api<{ notes: Note[], files: string[] }>('/api/notes').then((r) => { notes.value = r.notes; noteFiles.value = r.files }, () => {})
// null: no such file; undefined: not read (the network, the server), never "missing".
export const loadNoteFile = (path: string) => api<{ text: string | null }>(`/api/notes/file?path=${encodeURIComponent(path)}`).then(r => r.text, () => undefined)
// Open but out of sight: the panel was beside the conversation and the page
// now shown has none (the board, a settings page). Back in the panel beside
// the next conversation or Home; only an explicit open shows it as a sheet.
export const notesAway = ref(false)
export function openNotes() {
  notesOpen.value = true
  notesAway.value = false
}
export function toggleNotes() {
  if (notesOpen.value && !notesAway.value) notesOpen.value = false
  else openNotes()
}
