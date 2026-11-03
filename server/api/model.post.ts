// Change the model of an idle agent, for this session only (never
// as the global default: see server/utils/modelctl.ts).
export default defineApi(async (event, b) => {
  if (!PANE_RE.test(b.pane_id || '')) throw new HerdrError('bad_pane', 'Invalid pane')
  // Composite models only: { parts: { lead, sidekick } } — any other key or a
  // non-string value is dropped before it reaches the driver.
  const raw = b.parts && typeof b.parts === 'object' ? b.parts as Record<string, unknown> : {}
  const parts: Record<string, string> = {}
  for (const k of ['lead', 'sidekick'] as const) {
    const v = raw[k]
    if (typeof v === 'string' && v.length <= 80) parts[k] = v
  }
  const model = await setModel(b.pane_id, String(b.label || ''), Object.keys(parts).length ? parts : undefined)
  const p = findPane(b.pane_id)
  if (p) refreshModel(p)
  return { ok: true, model }
})
