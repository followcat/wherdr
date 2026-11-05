// A missing preference follows the new default; choices already saved take priority.
export function readShowShells(stored: string | null): boolean {
  return stored !== '0'
}
