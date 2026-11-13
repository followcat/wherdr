// Change the model of an idle agent, for this session only (never the
// account default: see server/utils/coreModelctl.ts). Claude/Codex only —
// Devin parts, omp, OpenCode and cmd land with their own tasks.
export default defineApi(async (_event, b) => {
  const paneId = typeof b.pane_id === 'string' ? b.pane_id : ''
  if (!PANE_RE.test(paneId)) throw new HerdrError('bad_pane', 'Invalid pane')
  const wanted = String(b.label ?? b.wanted ?? '')
  if (wanted.length > 80) throw new HerdrError('bad_model', 'Invalid model')
  // Composite models only: { parts: { lead, sidekick } } — any other key or a
  // non-string value is dropped before it reaches the driver.
  const raw = b.parts && typeof b.parts === 'object' && !Array.isArray(b.parts) ? b.parts as Record<string, unknown> : {}
  const parts: Record<string, string> = {}
  for (const k of ['lead', 'sidekick'] as const) {
    const v = raw[k]
    if (typeof v === 'string' && v.length <= 80) parts[k] = v
  }
  const model = await coreModelCtl().setModel(paneId, wanted, Object.keys(parts).length ? parts : undefined)
  const p = findPane(paneId)
  if (p) refreshModel(p)
  return { ok: true, model }
})
