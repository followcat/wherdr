// Effort levels an agent offers (claude slider, codex effort menu, omp's
// ⇧⇥ cycle knowledge) and the current one. Agents with no effort UI return
// an empty list — read-only, never a change.
export default defineApi(async (event) => {
  const pane = String(getQuery(event).pane || '')
  if (!PANE_RE.test(pane)) throw new HerdrError('bad_pane', 'Invalid pane')
  const result = await coreModelCtl().listEfforts(pane)
  const p = findPane(pane)
  if (p && result.current) refreshModel(p)
  return result
})
