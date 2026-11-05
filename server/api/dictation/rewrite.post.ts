// The optional rewrite of a take's text by a cheap chat model on OpenRouter
// (at most 2 at once, 10 per client per minute: server/utils/dictation.ts).
// Body: { text, model?, prompt?, dictionary?: string[], zdr? }.
export default defineApi((event, b) => {
  const gone = new AbortController()
  const res = event.node.res
  res.on('close', () => { if (!res.writableFinished) gone.abort() })
  return dictation.rewrite(b || {}, gone.signal, clientKey(event))
})
