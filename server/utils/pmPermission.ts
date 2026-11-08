// One tap on an agent's permission request in Decisions: the agent's screen
// is read again and its prompt's own Yes or No option is chosen through
// herdr-core, as when the user answers in the agent's terminal.
import type { Choices } from '../../shared/types'
import type { CoreAdminDeps } from './coreCreate'
import { keysFor } from './choices'
import { readCoreScreen } from './coreScreen'
import { HerdrError } from './herdr'
import type { PmStore } from './pmStore'

// The keys that pick Yes (allow) or No (deny); No falls back to Esc, which
// Claude and Codex both read as a refusal. null: no permission prompt shown.
export function permissionKeys(choices: Choices | null, allow: boolean): string[] | null {
  if (!choices?.options.length) return null
  const i = choices.options.findIndex(o => (allow ? /^(yes|allow|approve)\b/i : /^(no|deny|reject)\b/i).test(o.label.trim()))
  return i >= 0 ? keysFor(choices, i) : allow ? null : ['esc']
}

export async function answerPermission(deps: CoreAdminDeps & { store: PmStore }, id: unknown, allow: unknown) {
  const { store } = deps
  const task = await store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  const run = (await store.runs()).find(r => r.id === task.run)
  if (!run?.terminal || run.state === 'ended') throw new HerdrError('not_found', 'The task\'s agent is not running')
  // The screen only (lines: 0), as every Claude screen read: herdr-core does not answer a history read of a Claude terminal.
  const screen = await deps.call<{ text?: string }>('terminal.read', { terminal: run.terminal, lines: 0 }, 3000)
  const keys = permissionKeys(readCoreScreen(String(screen?.text || ''), run.program, 'blocked').choices, allow === true)
  if (!keys) throw new HerdrError('stale', 'No permission prompt on the agent\'s screen: open the agent')
  await deps.call('terminal.keys', { terminal: run.terminal, keys }, 10000)
  const saved = task.waitKind === 'permission' ? { ...task, state: 'working' as const, waiting: undefined, waitKind: undefined } : task
  return store.logTask(saved, 'user', allow === true ? 'allowed the agent\'s permission request' : 'denied the agent\'s permission request')
}
