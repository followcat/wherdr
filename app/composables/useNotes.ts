// The Notes panel (NotesPanel.vue): open or not, its filter (kept on the
// server, like the Board's project picker), and the notes, read again every
// few seconds while it is open so an agent's change shows without a reload.
import { NOTES_FOLLOW, noteTabs, tabScope, type Note } from '#shared/notes'
import { syncedRef } from './useSyncedSettings'

export const notesOpen = ref(false)
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
export const loadNoteFile = (path: string) => api<{ text: string | null }>(`/api/notes/file?path=${encodeURIComponent(path)}`).then(r => r.text, () => null)
export function toggleNotes() { notesOpen.value = !notesOpen.value }
