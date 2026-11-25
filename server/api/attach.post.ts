// File attached to a message (PDF, text, code, notebook), for the agent of
// `pane`: stored on its machine, the reference to write in the message is
// returned. `name`: the original file name (kept, made safe).
import { ATTACH_MAX } from '../../shared/attachments'

export default defineApi((event, b) => {
  const q = getQuery(event)
  const pane = String(q.pane || '')
  // Core ids (`s<hex>:p<n>`): corePutAttachment checks the pane itself.
  return corePutAttachment(coreInputDeps(pane), pane, String(q.name || '').slice(0, 255), b.data)
}, { raw: /^application\/octet-stream$/, max: ATTACH_MAX, tooLarge: 'File too large (30 MB max)' })
