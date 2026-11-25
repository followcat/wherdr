// Mark a conversation read or unread (wherdr's own "seen").
export default defineApi(async (_event, b) => coreSeen(coreInputDeps(b.pane_id), b))
