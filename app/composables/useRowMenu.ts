// Right click and long press open a row's menu, as on the agent cards (AgentCard):
// on a mouse computer the dropdown at the pointer (UContextMenu fed with
// `dropdown(items)`), on a touch or narrow screen the bottom sheet, opened by a
// still long press or a mouse right click. One per list: its rows take turns.
// A row without items has no menu.
import type { MenuItem } from '~/composables/useUi'
import { longPress } from '~/utils/longPress'

type Items = () => MenuItem[]

export function useRowMenu() {
  let pointerType = ''
  let touchMenuAt = 0
  let target: { items: Items, title?: string } | null = null
  const sheet = () => {
    const items = target?.items() ?? []
    if (!items.length) return
    haptic()
    openMenu(items, target!.title)
  }
  const lp = longPress({ delay: 700, onPress: sheet })
  return {
    dropdown: (items: Items) => (sheetMenus.value ? [] : toDropdown(items())),
    on: (items: Items, title?: string) => ({
      pointerdown(e: PointerEvent) {
        pointerType = e.pointerType
        target = { items, title }
        // A link inside the row keeps its own tap.
        if (sheetMenus.value && !(e.target as Element | null)?.closest?.('a')) lp.down(e)
      },
      pointermove: lp.move,
      pointerup: lp.cancel,
      pointercancel: lp.cancel,
      selectstart: (e: Event) => e.preventDefault(),
      // A finger's contextmenu (Android long press) is left to the long press.
      contextmenu(e: MouseEvent) {
        if (!sheetMenus.value) return
        e.preventDefault()
        if (pointerType === 'touch' || pointerType === 'pen') return
        target = { items, title }
        sheet()
      },
    }),
    opened(open: boolean) {
      if (open && (pointerType === 'touch' || pointerType === 'pen')) touchMenuAt = Date.now()
    },
    // The click that ends a long press is not a tap.
    swallowClick: () => Date.now() - touchMenuAt < 1000 || lp.swallowClick(),
  }
}
