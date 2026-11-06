// Smooth touch scrolling is a device rendering preference, like the renderer.
// It defaults on for coarse-pointer devices that scroll with a finger and off
// on computers; a saved '0'/'1' always wins.
export function smoothTouchDefault(saved: string | null, coarsePointer: boolean) {
  return saved ? saved === '1' : coarsePointer
}
