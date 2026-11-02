// Old clients omit coordinates. Use the content area rather than (0, 0),
// which can be outside the application's scrollable conversation viewport.
export function terminalScrollPosition(value: Record<string, unknown>, cols: number, rows: number) {
  const coordinate = (v: unknown, size: number) => typeof v === 'number' && Number.isInteger(v)
    ? Math.max(0, Math.min(size - 1, v)) : Math.floor(size / 2)
  return {
    column: coordinate(value.column, cols),
    row: coordinate(value.row, rows),
    modifiers: typeof value.modifiers === 'number' && Number.isInteger(value.modifiers) ? value.modifiers & 15 : 0,
  }
}
