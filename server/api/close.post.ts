export default defineApi(async (_event, b) => coreKill(coreInputDeps(b.pane_id), b))
