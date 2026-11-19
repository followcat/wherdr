export default defineApi(async (event, b) => {
  const subs = await updateSubs(all => all.filter(s => s.endpoint !== (b && b.endpoint)))
  return { ok: true, devices: subs.length }
})
