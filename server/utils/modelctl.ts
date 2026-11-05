// Agent models: the current model of a pane, from its transcript or its
// config file.
import path from 'node:path'
import { hasTranscript } from '../../shared/agentKind'
import type { ModelInfo, Pane } from '../../shared/types'
import { transcripts } from './state'
import { machineOfPane } from './machines'
import { codexConfigModel } from './models'

// Codex without a reply yet: the model from its config on the agent's machine.
async function fallbackModel(p: Pane): Promise<ModelInfo | null> {
  const m = machineOfPane(p.id)
  if (p.agent !== 'codex' || !m || !m.home) return null
  try { return codexConfigModel(await m.fs.readFile(path.posix.join(m.home, '.codex/config.toml'))) }
  catch { return null }
}

export async function currentModel(p: Pane): Promise<ModelInfo | null> {
  if (!hasTranscript(p.agent)) return null
  // A failed read throws: the state keeps the model it showed (refreshModel).
  return (await transcripts.model(p)) || fallbackModel(p)
}
