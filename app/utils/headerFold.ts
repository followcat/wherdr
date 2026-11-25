// Agent list header: how many secondary icon buttons go into the "…" menu so
// the row never overflows. The logo and version shrink first (down to
// `HEADER_TITLE_MIN`), then the foldable buttons are replaced, one by one, by a single "…" button.
export const HEADER_BTN = 40
export const HEADER_GAP = 4
// Row gap between the logo and version and the buttons, and the buttons' negative right margin.
export const HEADER_ROW_GAP = 12
export const HEADER_EDGE = 6
// Room kept for the logo and the start of the version.
export const HEADER_TITLE_MIN = 104

function buttonsWidth(n: number): number {
  return n > 0 ? n * HEADER_BTN + (n - 1) * HEADER_GAP - HEADER_EDGE : 0
}

// `rowWidth`: width of the title row; `total`: visible buttons; `foldable`: how
// many of them may move into the menu; `extraWidth`: measured width of
// `[data-wherdr="header-actions"]` when populated. Returns how many to fold (0 = no menu).
export function headerFold(rowWidth: number, total: number, foldable: number, extraWidth = 0): number {
  const extra = extraWidth > 0 ? extraWidth + (total > 0 ? HEADER_GAP : 0) : 0
  const avail = rowWidth - HEADER_ROW_GAP - HEADER_TITLE_MIN - extra
  if (buttonsWidth(total) <= avail) return 0
  for (let k = 1; k <= foldable; k++) {
    if (buttonsWidth(total - k + 1) <= avail) return k
  }
  return foldable
}
