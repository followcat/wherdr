// A linked file's Markdown (?path=plans/x.md), shown rendered in the Notes
// panel; text null when it is missing or not a notes path.
import { notesStore } from '../../utils/notesStore'

export default defineApi(async event => ({ text: await notesStore().readFile(String(getQuery(event).path || '')) }))
