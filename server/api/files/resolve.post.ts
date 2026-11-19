// { pane, paths }: where each path written in the pane's conversation is found
// (agent's folder, repository, notes), within the Security setting's folders
// (utils/chatFiles.ts). One request for all the new paths of a message.
import os from 'node:os'
import { chatFilesRoots } from '../../../shared/chatFiles'
import { chatFilesPolicy } from '../../utils/chatFiles'
import { findWritten, notesAllowed } from '../../utils/files'
import { notesStore } from '../../utils/notesStore'
import { repoDirs } from '../../utils/writtenPlaces'

export default defineApi(async (_event, b) => {
  const p = findPane(String(b.pane || ''))
  if (!p) throw new HerdrError('bad_pane', 'Pane not found')
  const paths = Array.isArray(b.paths) ? b.paths : []
  const m = await coreFilesMachine(p.machine)
  const policy = await chatFilesPolicy()
  const store = notesStore()
  const notes = await notesAllowed(store.dir, chatFilesRoots(os.homedir(), policy.level)) ? { dir: store.dir, read: store.readFile } : undefined
  return { found: await findWritten(m, p.cwd, await repoDirs(p, m.home), paths, policy, notes) }
})
