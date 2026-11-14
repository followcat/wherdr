// The notes agents wrote (shared/notes.ts), newest first, and the linked
// files' paths, for the Notes panel: read-only for the user.
import { notesStore } from '../utils/notesStore'

export default defineApi(async () => {
  const store = notesStore()
  const [notes, files] = await Promise.all([store.list(), store.files()])
  return { notes, files }
})
