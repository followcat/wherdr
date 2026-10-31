export type TerminalRenderer = 'webgl' | 'html'
export type ActiveTerminalRenderer = 'webgl' | 'html' | 'html-fallback'

export function parseTerminalRenderer(value: string | null): TerminalRenderer {
  return value === 'html' ? 'html' : 'webgl'
}

export function activeTerminalRenderer(choice: TerminalRenderer, webglAvailable: boolean): ActiveTerminalRenderer {
  return choice === 'html' ? 'html' : webglAvailable ? 'webgl' : 'html-fallback'
}

export interface CanvasSize { width: number, height: number }

// The backing-store size of the WebGL canvas. xterm sets it to its CSS size ×
// devicePixelRatio, then corrects rounding from the browser's
// device-pixel-content-box report. Some browsers report the CSS size there:
// trusted, it shrinks the backing store and xterm, still drawing in device
// pixels, shows every glyph twice as large on a 2× screen. A report further
// from xterm's own size than rounding allows is ignored.
export function canvasDeviceSize(reported: CanvasSize, expected: CanvasSize, dpr: number): CanvasSize {
  const slack = Math.max(2, Math.ceil(dpr))
  const near = (a: number, b: number) => Math.abs(a - b) <= slack
  return near(reported.width, expected.width) && near(reported.height, expected.height) ? reported : expected
}

// What the guard needs from xterm's WebGL renderer (private in @xterm/addon-webgl 0.18).
interface WebglRendererInternals {
  dimensions: { device: { canvas: CanvasSize } }
  _setCanvasDevicePixelDimensions: (width: number, height: number) => void
}

// Routes the renderer's device-pixel resizes through canvasDeviceSize. Returns
// false when the addon's internals are not the expected ones (left untouched).
export function guardWebglCanvasSize(addon: object, dpr: () => number = () => globalThis.devicePixelRatio || 1): boolean {
  const renderer = (addon as { _renderer?: Partial<WebglRendererInternals> })._renderer
  const resize = renderer?._setCanvasDevicePixelDimensions
  if (!renderer || typeof resize !== 'function' || !renderer.dimensions?.device?.canvas) return false
  const r = renderer as WebglRendererInternals
  r._setCanvasDevicePixelDimensions = (width, height) => {
    const size = canvasDeviceSize({ width, height }, r.dimensions.device.canvas, dpr())
    resize.call(r, size.width, size.height)
  }
  return true
}
