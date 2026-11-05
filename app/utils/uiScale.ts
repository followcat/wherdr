// Interface size on a computer (Settings › Desktop), kept on this device:
// main surfaces and the terminal zoom up ~15%; the terminal's own text
// size stays the base.
export type UiScale = 'md' | 'lg'

export function readUiScale(raw: string | null): UiScale {
  return raw === 'md' ? 'md' : 'lg'
}
