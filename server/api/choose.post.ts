// Choose an option of a blocking prompt (see coreChoose.ts): the screen is
// re-read just before, and a changed question is refused.
export default defineApi(async (_event, b) => coreChoose(coreChooseDeps(b.pane_id), b))
