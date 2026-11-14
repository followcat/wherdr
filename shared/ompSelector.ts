// omp's model selector (alt+p, /switch, /model): a boxed list, recognized
// here only — its parsing and control live server-side (modelMenus.ts,
// coreModelctl.ts). Box and marks depend on omp's symbol preset
// (shared/ompSymbols.ts). A narrow pane cuts the footer ("⏎ use for this
// sessi…"): its first key hint is enough.
import { OMP_ENTER, OMP_UP_DOWN, ompAlt } from './ompSymbols'

export const OMP_SELECTOR_OPEN = /(?:╭─|\+-)\s*Switch (?:Task )?Model\b/
const OMP_SELECTOR_FOOTER = new RegExp(`${ompAlt(OMP_ENTER)}\\s*use for (?:this session|Task subagents)|${ompAlt(OMP_UP_DOWN)} models\\b`)

export function ompSelectorOnScreen(text: string | null | undefined): boolean {
  return Boolean(text) && OMP_SELECTOR_OPEN.test(String(text)) && OMP_SELECTOR_FOOTER.test(String(text))
}
