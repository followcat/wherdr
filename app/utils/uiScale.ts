// Interface size on a computer (Settings › Desktop), kept on this device:
// the agent side zooms up; the terminal keeps its own text size setting.
export type UiScale = 'md' | 'lg'

export function readUiScale(raw: string | null): UiScale {
  return raw === 'lg' ? 'lg' : 'md'
}
