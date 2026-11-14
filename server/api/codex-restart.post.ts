import { CODEX_UPDATED_LABEL, codexLine, quote } from '../../shared/codexLaunch'
import { PATH_SETUP } from '../utils/coreCreate'
// Explicit: the auto-import resolves `failure` to opencodeTransport's instead.
import { failure } from '../utils/coreInput'

// "Your turn" card of a Codex that exited after updating itself: starts it again
// in the same terminal (a plain sh by now), on the same conversation (`how`:
// 'resume') or a new one. A session wherdr cannot identify opens Codex's own
// picker rather than another pane's latest conversation.
const SESSION = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/
export default defineApi(async (_event, b) => {
  const deps = coreInputDeps()
  const p = deps.pane(String(b.pane_id))
  if (!p?.coreAddress || !p.stopped) throw new HerdrError('bad_pane', 'Codex is not waiting for a restart here')
  let args: string[] = []
  if (b.how === 'resume') {
    const id = SESSION.exec((await transcripts.locate(p).catch(() => null))?.file || '')?.[1]
    args = id ? ['resume', id] : ['resume']
  }
  try {
    await deps.call('terminal.label', { terminal: p.coreAddress, labels: { [CODEX_UPDATED_LABEL]: '' } }, 8000)
    await deps.call('terminal.send', { terminal: p.coreAddress, text: `exec sh -c ${quote(`${PATH_SETUP}; ${codexLine(args)}`)}` }, 30000)
  } catch (e) { failure(e) } finally { deps.refresh() }
  return { ok: true }
})
