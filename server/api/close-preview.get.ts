import { SPLIT_PROMPT_TOKEN } from '../utils/splitShell'
import { closeProcess } from '../../shared/closeProcess'

// On demand only; herdr routes prefixed pane IDs to the remote machine too.
export default defineApi(async (event) => {
  const pane = String(getQuery(event).pane || '')
  if (!PANE_RE.test(pane)) throw new HerdrError('bad_pane', 'Invalid pane')
  try {
    const r = await herdr('pane.process_info', { pane_id: pane }, 3000)
    const process = closeProcess(r?.process_info)
    if (process.state !== 'unknown') return process
    const p = await herdr('pane.get', { pane_id: pane }, 3000)
    return closeProcess(r?.process_info, p?.pane?.tokens?.[SPLIT_PROMPT_TOKEN])
  } catch {
    return { state: 'unknown' as const }
  }
})
