type Point = { x: number, y: number }

// Predictive visual offset: the screen follows the finger 1:1 while sent
// scrolls wait for their frames. Three rows of exact lead make the drag
// read as continuous; cached rows (extraPx) extend the exact zone with real
// content the transcript cache already painted, and past the zone a rubber
// band damps toward the cap so a stalled server never drags the grid far
// out of its frame.
export function touchPreviewOffset(px: number, rowHeight: number, extraPx = 0) {
  const h = Math.max(1, rowHeight)
  const lead = h * 3 + Math.max(0, extraPx)
  const cap = lead + h * 3
  const over = Math.abs(px) - lead
  if (over <= 0) return px
  return Math.sign(px) * Math.min(cap, lead + over * 0.25)
}

// Touch-only physics: preserve fractional pixels, lock the drag direction,
// and keep momentum bounded. Scrolling never becomes arrow keys.
export function createTerminalTouch({ vertical, momentum, horizontal, canHorizontal, maxMomentum,
  now = () => performance.now(), frame = fn => requestAnimationFrame(fn), cancelFrame = id => cancelAnimationFrame(id),
}: {
  vertical: (pixels: number, point: Point) => void
  // Momentum ticks may take a different path than the finger: nothing follows
  // a finger anymore, so fabricated preview only shows as an afterimage.
  momentum?: (pixels: number, point: Point) => void
  horizontal: (pixels: number) => void
  canHorizontal: () => boolean
  maxMomentum: () => number
  now?: () => number
  frame?: (fn: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
}) {
  let start: Point | null = null
  let last: Point = { x: 0, y: 0 }
  let at = 0
  let axis: 'x' | 'y' | null = null
  let speed = 0
  // Trailing ~100ms of movement, like the iOS velocity window: a flick that
  // only got fast at the end of the drag still releases at its real speed.
  let trail: { dy: number, dt: number }[] = []
  let raf = 0
  const stopMomentum = () => { if (raf) cancelFrame(raf); raf = 0 }
  const cancel = () => { stopMomentum(); start = null; speed = 0; axis = null; trail = [] }
  return {
    start(x: number, y: number) {
      cancel()
      start = last = { x, y }
      at = now()
    },
    move(x: number, y: number) {
      if (!start) return
      const t = now(), point = { x, y }
      const dx = x - last.x, dy = y - last.y, dt = Math.max(1, t - at)
      if (!axis) {
        const totalX = x - start.x, totalY = y - start.y
        if (Math.hypot(totalX, totalY) < 5) return
        axis = canHorizontal() && Math.abs(totalX) > Math.abs(totalY) * 1.25 ? 'x' : 'y'
      }
      if (axis === 'x') horizontal(dx)
      else {
        vertical(dy, point)
        if (dy && speed && Math.sign(dy) !== Math.sign(speed)) trail = []
        trail.push({ dy, dt })
        let span = 0, from = trail.length
        while (from > 0 && span < 100) span += trail[--from]!.dt
        trail = trail.slice(from)
        const dtSum = trail.reduce((n, s) => n + s.dt, 0)
        speed = Math.max(-3, Math.min(3, trail.reduce((n, s) => n + s.dy, 0) / Math.max(1, dtSum)))
      }
      last = point
      at = t
    },
    end() {
      if (!start) return false
      const tap = axis === null
      start = null
      const held = now() - at
      if (axis !== 'y' || held > 90) return tap
      // Lifted after slowing down: the flick starts from the speed the
      // finger still had, like iOS bleeding velocity during a hold.
      speed *= Math.exp(-Math.max(0, held - 25) / 50)
      if (Math.abs(speed) < .16) return tap
      const began = now()
      let previous = began, distance = 0
      const limit = Math.max(0, maxMomentum())
      const step: FrameRequestCallback = () => {
        raf = 0
        const t = now(), dt = Math.min(40, Math.max(0, t - previous))
        previous = t
        speed *= Math.exp(-dt / 170)
        const pixels = Math.sign(speed) * Math.min(Math.abs(speed * dt), Math.max(0, limit - distance))
        distance += Math.abs(pixels)
        if (pixels) (momentum ?? vertical)(pixels, last)
        if (Math.abs(speed) > .045 && t - began < 750 && distance < limit) raf = frame(step)
      }
      raf = frame(step)
      return tap
    },
    stopMomentum,
    cancel,
    // Trailing drag velocity in px/ms -- drives the read-ahead overshoot.
    velocity: () => speed,
  }
}
