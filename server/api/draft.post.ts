// Text left unsent in Claude's input box, or its queue (WHR-286):
// action "send" (Enter), "clear" (empty the box) or "send-queued" (ctrl+enter).
export default defineApi(async (_event, b) => {
  return coreDraft(coreDraftDeps(b.pane_id), b)
})
