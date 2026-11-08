// The user's Decisions (GET /api/pm/decisions), and one grouped push every
// 30 s for what is new among them (server/plugins/pm.ts), instead of one per item.
import { decisionsOf, decisionsPush } from '../../shared/pm/decisions'
import { board } from './pmBoard'
import type { PmStore } from './pmStore'
import { pushSend } from './push'

export async function decisions(store: PmStore) {
  if (!(await store.enabled())) return []
  const [b, tasks, wakes, projects] = [await board(store), await store.tasks(), await store.wakes(), await store.projects()]
  const coordinators = await Promise.all(projects.map(async (p) => {
    const c = await store.coordinator(p.key)
    return { project: p.key, name: p.name, ...(c?.proposal ? { proposal: { at: c.proposal.at, ...(c.proposal.said ? { said: c.proposal.said } : {}) } } : {}) }
  }))
  return decisionsOf({ cards: b.cards, tasks, coordinators, wakes })
}

// What was pushed already; null until the first tick, which only notes what
// waits (a restart does not push the same decisions again).
let told: Set<string> | null = null
type Notify = (p: { title: string, titleFr: string, body: string }, badge: number) => Promise<unknown>
const pushNotify: Notify = (p, badge) => pushSend({ ...p, tag: 'pm-decisions', url: '/#/decisions', badge })

export async function decisionsTick(store: PmStore, notify: Notify = pushNotify) {
  const ds = await decisions(store)
  const p = told && decisionsPush(ds, told)
  told = new Set(ds.map(d => d.id))
  if (p) await notify(p, ds.length).catch(() => {})
  return p
}
export const resetDecisionsTold = () => { told = null }
