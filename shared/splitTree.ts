// wherdr's own split layout of a tab (herdr-app keeps its own, never written):
// a binary tree whose leaves are terminals (`coreAddress`, stable), kept per tab
// id in the synced setting `tabSplits` and drawn as a TabLayout by `entryOf`.
import type { LayoutSplit, TabLayout } from './layout'
import { SETTING_MAX } from './settings'

export type SplitDir = 'right' | 'down'
// `right`: a on the left, b on the right; `down`: a on top. `ratio`: a's share.
export interface SplitNode { dir: SplitDir, ratio: number, a: SplitTree, b: SplitTree }
export type SplitTree = string | SplitNode
export type TabSplits = Record<string, SplitTree>

export const treeLeaves = (t: SplitTree): string[] => (typeof t === 'string' ? [t] : [...treeLeaves(t.a), ...treeLeaves(t.b)])

// Without the leaves not in `keep`: a removed leaf's sibling takes its room. Null if nothing is left.
export function pruneTree(t: SplitTree, keep: (leaf: string) => boolean): SplitTree | null {
  if (typeof t === 'string') return keep(t) ? t : null
  const a = pruneTree(t.a, keep)
  const b = pruneTree(t.b, keep)
  return a && b ? { ...t, a, b } : a ?? b
}

export const removeLeaf = (t: SplitTree, leaf: string) => pruneTree(t, l => l !== leaf)

// The tree for exactly `present` (in their order): gone leaves pruned, the missing ones
// stacked at the bottom, each with its share of the height. Null when `present` is empty.
export function fitTree(t: SplitTree | null | undefined, present: string[]): SplitTree | null {
  const set = new Set(present)
  let out = t ? pruneTree(t, l => set.has(l)) : null
  const have = new Set(out ? treeLeaves(out) : [])
  for (const leaf of present) {
    if (have.has(leaf)) continue
    const n = out ? treeLeaves(out).length : 0
    out = out ? { dir: 'down', ratio: n / (n + 1), a: out, b: leaf } : leaf
  }
  return out
}

// `target` split in two along `dir`: it keeps the first half, `leaf` takes the second.
// A target missing from the tree is added at the bottom first.
export function insertSplit(t: SplitTree | null | undefined, target: string, leaf: string, dir: SplitDir): SplitTree {
  const base = t && treeLeaves(t).includes(target) ? t : fitTree(t, [...(t ? treeLeaves(t) : []), target])!
  const put = (n: SplitTree): SplitTree => (typeof n === 'string'
    ? (n === target ? { dir, ratio: 0.5, a: n, b: leaf } : n)
    : { ...n, a: put(n.a), b: put(n.b) })
  return put(removeLeaf(base, leaf) ?? target)
}

// The tree as a layout in a 1000×1000 area (only proportions matter): panes in
// reading order (left before right, top before bottom), splits with their path.
// `pane`: the pane id of a leaf.
export function treeLayout(tab: { id: string, workspace: string }, t: SplitTree, pane: (leaf: string) => string): TabLayout {
  const panes: TabLayout['panes'] = []
  const splits: LayoutSplit[] = []
  const walk = (n: SplitTree, path: string, x: number, y: number, w: number, h: number) => {
    if (typeof n === 'string') { panes.push({ pane: pane(n), rect: { x, y, width: w, height: h } }); return }
    splits.push({ path, direction: n.dir, ratio: n.ratio, rect: { x, y, width: w, height: h } })
    if (n.dir === 'right') {
      walk(n.a, `${path}0`, x, y, w * n.ratio, h)
      walk(n.b, `${path}1`, x + w * n.ratio, y, w * (1 - n.ratio), h)
    } else {
      walk(n.a, `${path}0`, x, y, w, h * n.ratio)
      walk(n.b, `${path}1`, x, y + h * n.ratio, w, h * (1 - n.ratio))
    }
  }
  walk(t, '', 0, 0, 1000, 1000)
  return { tab: tab.id, workspace: tab.workspace, zoomed: false, focused: panes[0]?.pane ?? null, area: { x: 0, y: 0, width: 1000, height: 1000 }, panes, splits }
}

// A divider's ratio is kept between these bounds (each side keeps 15 %).
export const clampRatio = (r: number) => Math.round(Math.min(0.85, Math.max(0.15, r)) * 1000) / 1000

// The tree with the split at `path` ('' root, '0' first child, '1' second…) set to `ratio`.
export function setRatio(t: SplitTree, path: string, ratio: number): SplitTree {
  if (typeof t === 'string') return t
  if (!path) return { ...t, ratio: clampRatio(ratio) }
  return path[0] === '0' ? { ...t, a: setRatio(t.a, path.slice(1), ratio) } : { ...t, b: setRatio(t.b, path.slice(1), ratio) }
}

function cleanTree(v: unknown): SplitTree | null {
  if (typeof v === 'string') return v || null
  if (!v || typeof v !== 'object') return null
  const n = v as Record<string, unknown>
  const a = cleanTree(n.a)
  const b = cleanTree(n.b)
  const ratio = Number(n.ratio)
  if ((n.dir !== 'right' && n.dir !== 'down') || !(ratio > 0 && ratio < 1)) return null
  return a && b ? { dir: n.dir, ratio, a, b } : a ?? b
}

// The setting's text → trees by tab id (anything malformed dropped).
export function readTabSplits(raw: string | null | undefined): TabSplits {
  let v: unknown
  try { v = raw ? JSON.parse(raw) : null } catch { return {} }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: TabSplits = {}
  for (const [tab, t] of Object.entries(v)) {
    const tree = cleanTree(t)
    if (tree && typeof tree !== 'string') out[tab] = tree
  }
  return out
}

// The text to store: trees of tabs that are gone (`alive` false) dropped, then the
// oldest ones until it fits the setting's limit.
export function writeTabSplits(splits: TabSplits, alive: (tab: string) => boolean = () => true): string {
  const entries = Object.entries(splits).filter(([tab, t]) => alive(tab) && typeof t !== 'string')
  const text = () => JSON.stringify(Object.fromEntries(entries))
  while (entries.length && text().length > SETTING_MAX) entries.shift()
  return text()
}
