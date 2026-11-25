// "Keep after restart" of a terminal.
export default defineApi(async (event) => {
  const pane = String(getQuery(event).pane || '')
  return coreKeepGet(coreInputDeps(pane), pane)
})
