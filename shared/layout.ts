// Layout of a Herdr tab (session.snapshot → `layouts[]`): pane rectangles
// in cells of the attached client (120×40 without a client), to reproduce as
// percentages whatever the screen size.

export interface CellRect { x: number, y: number, width: number, height: number }
// Split of Herdr's tree: `path` = path from the root ('' for the root,
// '0' first child, '1' second…), taken from its id (`split_2_11`); `right` =
// side by side (first on the left), `down` = stacked (first on top).
export interface LayoutSplit { path: string, direction: 'right' | 'down', ratio: number, rect: CellRect }
export interface TabLayout {
  tab: string
  workspace: string
  zoomed: boolean
  focused: string | null
  area: CellRect
  panes: { pane: string, rect: CellRect }[]
  // Missing: rebuilt layout or old state (no dragging or resizing).
  splits?: LayoutSplit[]
}
// Position of a pane as a percentage of the tab (0 to 100).
export interface PaneBox { pane: string, left: number, top: number, width: number, height: number }

const pct = (v: number, total: number) => (total > 0 ? Math.round((v / total) * 10000) / 100 : 0)

export function paneBoxes(layout: TabLayout): PaneBox[] {
  const { area } = layout
  return readingOrder(layout).map(({ pane, rect }) => ({
    pane,
    left: pct(rect.x - area.x, area.width),
    top: pct(rect.y - area.y, area.height),
    width: pct(rect.width, area.width),
    height: pct(rect.height, area.height),
  }))
}

// Reading order: Herdr's, which walks the split tree (left half
// before right, top before bottom): the left column first when
// it spans several rows, row by row for a grid split into
// rows. Used for swiping on the phone.
export function readingOrder(layout: TabLayout) {
  return layout.panes
}

// Neighbouring pane in reading order (swipe left / right), without wrapping.
export function neighborPane(layout: TabLayout, pane: string, step: 1 | -1): string | null {
  const order = readingOrder(layout).map(p => p.pane)
  const i = order.indexOf(pane)
  if (i < 0) return null
  return order[i + step] ?? null
}

// `layouts[]` brut de session.snapshot → TabLayout (identifiants tels quels).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reduceLayout(raw: any, id: (x: string) => string = x => x): TabLayout | null {
  if (!raw || !raw.tab_id || !raw.area || !Array.isArray(raw.panes)) return null
  const rect = (r: CellRect): CellRect => ({ x: r.x | 0, y: r.y | 0, width: r.width | 0, height: r.height | 0 })
  const splits: LayoutSplit[] = []
  for (const x of Array.isArray(raw.splits) ? raw.splits : []) {
    const path = splitPath(x?.id)
    if (path == null || !x.rect || (x.direction !== 'right' && x.direction !== 'down') || !(x.ratio > 0 && x.ratio < 1)) continue
    splits.push({ path, direction: x.direction, ratio: Number(x.ratio), rect: rect(x.rect) })
  }
  return {
    tab: id(String(raw.tab_id)),
    workspace: id(String(raw.workspace_id)),
    zoomed: Boolean(raw.zoomed),
    focused: raw.focused_pane_id ? id(String(raw.focused_pane_id)) : null,
    area: rect(raw.area),
    panes: raw.panes.filter((p: { pane_id?: string, rect?: CellRect }) => p && p.pane_id && p.rect)
      .map((p: { pane_id: string, rect: CellRect }) => ({ pane: id(p.pane_id), rect: rect(p.rect) })),
    ...(Array.isArray(raw.splits) ? { splits } : {}),
  }
}

// `split_0_root` -> '', `split_2_11` -> '11' (Herdr 0.9.1: rank of the split
// in the tree walk, then its path); null if unknown.
export function splitPath(id: unknown): string | null {
  if (id === 'split_0_root') return ''
  const m = /^split_\d+_([01]+)$/.exec(String(id ?? ''))
  return m ? m[1]! : null
}

// Layout to show for a tab: Herdr's, otherwise its panes
// stacked in equal parts (state without `layouts`, old state kept offline).
export function tabLayout(tab: { id: string, workspace: string, layout: TabLayout | null }, panes: string[]): TabLayout {
  if (tab.layout && tab.layout.panes.length) return tab.layout
  const n = Math.max(1, panes.length)
  const h = 40
  return {
    tab: tab.id,
    workspace: tab.workspace,
    zoomed: false,
    focused: panes[0] ?? null,
    area: { x: 0, y: 0, width: 120, height: h * n },
    panes: panes.map((pane, i) => ({ pane, rect: { x: 0, y: i * h, width: 120, height: h } })),
  }
}
