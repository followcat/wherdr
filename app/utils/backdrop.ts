// The wherdr grid in the margins of the conversation on a computer
// (components/GridBackdrop.vue): the website's grid, dots at the crossings and
// travelling packets. Phones show none.

// Grid cell, in CSS pixels (same as GRID_CELL in website/app/utils/grid.ts).
export const BACKDROP_CELL = 64
export const MAX_PACKETS = 3

export interface PacketPlan {
  vertical: boolean
  reverse: boolean
  alt: boolean
  cells: number
  /** Offset of the start point in the box, in px, on a grid line. */
  left: number
  top: number
  /** Travel distance along the line, in px. */
  dist: number
  duration: number
}

/**
 * Where the next packet runs, for a box of w×h px whose grid tiles are centred
 * horizontally and start at the top. Same values as the website background
 * (website/app/components/GridBackground.vue, variant 5). `rnd` returns [0, 1).
 */
export function planPacket(w: number, h: number, rnd: () => number = Math.random): PacketPlan {
  const rand = (a: number, b: number) => a + rnd() * (b - a)
  const x0 = w / 2 - BACKDROP_CELL / 2
  const vertical = rnd() < 0.4
  const cells = Math.round(rand(4, 9))
  const dist = cells * BACKDROP_CELL
  const reverse = rnd() < 0.5
  const alt = rnd() < 0.3
  let left: number
  let top: number
  if (vertical) {
    // A column near the middle, in the visible part of the fade.
    const k = Math.round(rand(-w * 0.32, w * 0.32) / BACKDROP_CELL)
    const row = Math.round(rand(0, Math.max(1, h * 0.45 / BACKDROP_CELL)))
    left = x0 + k * BACKDROP_CELL
    top = row * BACKDROP_CELL
  } else {
    const row = Math.round(rand(1, Math.max(2, h * 0.55 / BACKDROP_CELL)))
    const k = Math.round(rand(-w * 0.4, w * 0.4 - dist) / BACKDROP_CELL)
    top = row * BACKDROP_CELL
    left = x0 + k * BACKDROP_CELL
  }
  return { vertical, reverse, alt, cells, left, top, dist, duration: cells * rand(300, 420) }
}

/** Delay before the next packet: short bursts and long pauses, never in step. */
export function nextPacketDelay(rnd: () => number = Math.random): number {
  return rnd() < 0.25 ? 2600 + rnd() * 1600 : 500 + rnd() * 1300
}
