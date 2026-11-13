// Change an agent's effort level for this session only — claude's slider
// ("s", never Enter), codex's effort page, omp's ⇧⇥ cycle. Never a global
// default.
export default defineApi(async (_event, b) => {
  const paneId = typeof b.pane_id === 'string' ? b.pane_id : ''
  if (!PANE_RE.test(paneId)) throw new HerdrError('bad_pane', 'Invalid pane')
  const level = String(b.level || '')
  if (level.length > 40) throw new HerdrError('bad_effort', 'Invalid effort level')
  const model = await coreModelCtl().setEffort(paneId, level)
  const p = findPane(paneId)
  if (p) refreshModel(p)
  return { ok: true, model }
})
