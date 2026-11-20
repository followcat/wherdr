// "…" menu of an agent with herdr-core (WHR-244). The base items live here; a
// lot adds its own in app/utils/coreAgentMenu/<lot>.ts, so AgentView.vue stays
// untouched by those lots.
import { t } from './i18n'
import type { MenuItem } from '~/composables/useUi'
import type { Pane } from '#shared/types'
import d from './coreAgentMenu/d'
import e from './coreAgentMenu/e'
import f from './coreAgentMenu/f'
import g from './coreAgentMenu/g'
import h from './coreAgentMenu/h'

export interface CoreMenuContext {
  pane: Pane | undefined
  /** "Keep after restart" of the pane (WHR-252): absent until its state is read. */
  keep?: { on: boolean, toggle: () => void }
  /** Take control of the terminal / reconnect it (they live in AgentView). */
  takeControl: () => void
  reconnect: () => void
  /** Opens the rename sheet for a pane. */
  rename: (paneId: string) => void
  /** Opens the file browser of the agent's folder. */
  browseFiles: () => void
  /** Split right / down entries of the pane (absent when its folder is unknown), already built. */
  split?: MenuItem[]
  /** "Open in editor" entry, absent when the pane has no folder on a Mac. */
  editor?: MenuItem
  /** Settings entries (not in a side-by-side cell), already built. */
  settings: MenuItem[]
  /** Close entry, absent on the compact phone. */
  close: MenuItem | undefined
}

export type CoreMenuContribution = (ctx: CoreMenuContext) => MenuItem[]

const CONTRIBUTIONS: CoreMenuContribution[] = [d, e, f, g, h]

export function coreAgentMenu(ctx: CoreMenuContext): MenuItem[] {
  const items: MenuItem[] = [
    { label: t('Take control of this terminal'), icon: 'i-lucide-arrow-left-right', run: ctx.takeControl },
    { label: t('Reconnect'), icon: 'i-lucide-refresh-cw', run: ctx.reconnect },
  ]
  if (ctx.editor) items.push(ctx.editor)
  for (const contribute of CONTRIBUTIONS) items.push(...contribute(ctx))
  items.push(...ctx.settings)
  if (ctx.close) items.push({ kind: 'separator' }, ctx.close)
  return items
}
