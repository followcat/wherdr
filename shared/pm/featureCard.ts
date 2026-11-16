// A workspace's feature on the board (docs/workspaces.md#features): one card
// with its sub-tasks as chips, its progress, its merge order and what waits.
// Its lane comes from its sub-tasks, as featureState does from the tasks.
import type { Card, Phase } from './board'

export type ChipState = 'todo' | 'working' | 'waiting' | 'done' | 'abandoned'
export interface FeatureChip { id: string, shown: string, color?: string, step?: string, state: ChipState }
export interface FeatureView {
  chips: FeatureChip[]
  merged: number // sub-tasks done (abandoned ones not counted)
  waits: { shown: string, on: string[] }[] // an open sub-task and the tasks it still waits for (after, mergeAfter)
}

const chipState = (c: Card): ChipState => (c.state?.abandoned ? 'abandoned' : c.phase === 'done' ? 'done'
  : c.yourTurn || c.stopped || c.asks ? 'waiting' : c.phase === 'working' ? 'working' : 'todo')
const open = (s: ChipState) => s !== 'done' && s !== 'abandoned'

export function featureView(f: Pick<Card, 'id'>, cards: Card[]): FeatureView {
  // In start order: each after the sub-tasks it waits for (after, then mergeAfter).
  const all = cards.filter(c => c.feature === f.id)
  const depth = (c: Card, seen: string[] = []): number => Math.max(0, ...[...c.after ?? [], ...c.mergeAfter ?? []]
    .map(id => all.find(x => x.id === id)).filter(x => !!x && !seen.includes(x.id)).map(x => 1 + depth(x!, [...seen, c.id])))
  const subs = all.map(c => ({ c, d: depth(c) })).sort((a, b) => a.d - b.d).map(x => x.c)
  const shown = (id: string) => cards.find(c => c.id === id)?.shown ?? id
  const chips = subs.map(c => ({ id: c.id, shown: c.shown, ...(c.color ? { color: c.color } : {}), ...(c.step ? { step: c.step } : {}), state: chipState(c) }))
  const waits = subs.flatMap((c, i) => {
    const on = [...new Set([...c.after ?? [], ...c.mergeAfter ?? []])].filter(id => cards.some(x => x.id === id && x.phase !== 'done'))
    return open(chips[i]!.state) && on.length ? [{ shown: c.shown, on: on.map(shown) }] : []
  })
  return { chips, merged: chips.filter(c => c.state === 'done').length, waits }
}

// The feature's card placed by its sub-tasks: Done once closed, Your turn while
// an open one waits for the user, Working once one started or ended, else To do.
export function featureCard(f: Card, cards: Card[]): Card {
  const subs = cards.filter(c => c.feature === f.id), states = subs.map(chipState)
  if (f.closed) return { ...f, phase: 'done' as Phase }
  const turn = subs.find((_, i) => states[i] === 'waiting')
  const phase: Phase = states.some(s => s !== 'todo') ? 'working' : 'todo'
  return { ...f, phase, ...(turn ? { yourTurn: `${turn.shown}: ${turn.yourTurn ?? 'waits for you'}` } : {}) }
}

// The board's cards with each feature placed by its sub-tasks; folded, the
// sub-tasks of a shown feature leave the columns (their chips are on its card).
export function withFeatures(cards: Card[], fold: boolean): Card[] {
  const features = new Set(cards.filter(c => c.kind === 'feature').map(c => c.id))
  return cards.filter(c => !fold || !c.feature || !features.has(c.feature)).map(c => (c.kind === 'feature' ? featureCard(c, cards) : c))
}
