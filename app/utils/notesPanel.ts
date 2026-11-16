// The Notes panel open beside the conversation, and the linked file it shows,
// kept on the device (a phone and a computer differ) so a reload brings it
// back. Stored: absent when closed, else the open file's path ('' for the list).
const KEY = 'notesPanel'

// Where there is no room for the panel (a phone), Notes is a sheet: a reload
// does not reopen it over the conversation.
export function readNotesPanel(room: boolean): { open: boolean, file: string } {
  try {
    const v = room ? localStorage.getItem(KEY) : null
    return { open: v !== null, file: v ?? '' }
  } catch { return { open: false, file: '' } }
}

export function saveNotesPanel(open: boolean, file: string | null) {
  try {
    if (open) localStorage.setItem(KEY, file ?? '')
    else localStorage.removeItem(KEY)
  } catch { /* storage unavailable */ }
}
