export type TerminalRenderer = 'webgl' | 'html'
export type ActiveTerminalRenderer = 'webgl' | 'html' | 'html-fallback'

export function parseTerminalRenderer(value: string | null): TerminalRenderer {
  return value === 'html' ? 'html' : 'webgl'
}

export function activeTerminalRenderer(choice: TerminalRenderer, webglAvailable: boolean): ActiveTerminalRenderer {
  return choice === 'html' ? 'html' : webglAvailable ? 'webgl' : 'html-fallback'
}

export interface CanvasSize { width: number, height: number }

// A canvas above this many device pixels cannot be trusted to keep a WebGL
// drawing buffer: iOS Safari caps a canvas near 16.7 M px, and Chrome clamps
// the drawing buffer of a large one (a 200×120 grid at devicePixelRatio 4 asks
// for 5600×7680 and got 4918×6745 on a real phone). A clamped buffer draws
// nothing that reaches the screen, so such a grid belongs on xterm's DOM
// renderer until it shrinks.
export const MAX_WEBGL_PIXELS = 16_777_216

// What the addon's private renderer holds for the canvas and its context.
export interface WebglBuffer extends CanvasSize {
  drawingBufferWidth: number
  drawingBufferHeight: number
}

export function webglBufferOf(addon: object): WebglBuffer | null {
  const renderer = (addon as { _renderer?: { _canvas?: CanvasSize, _gl?: WebGL2RenderingContext } })._renderer
  const canvas = renderer?._canvas
  const gl = renderer?._gl
  if (!canvas || !gl) return null
  return {
    width: canvas.width,
    height: canvas.height,
    drawingBufferWidth: gl.drawingBufferWidth,
    drawingBufferHeight: gl.drawingBufferHeight,
  }
}

// The browser gave the canvas less than it asked for (Chrome clamps the
// drawing buffer, same ratio on both axes), or the canvas is over the safe
// size. Device-pixel rounding may shave a pixel, hence the slack.
export function webglBufferUnusable(buffer: WebglBuffer, maxPixels = MAX_WEBGL_PIXELS, slack = 2): boolean {
  if (buffer.width <= 0 || buffer.height <= 0) return false
  if (buffer.width * buffer.height > maxPixels) return true
  return buffer.drawingBufferWidth < buffer.width - slack || buffer.drawingBufferHeight < buffer.height - slack
}

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
  _canvas?: CanvasSize
  dimensions: { device: { canvas: CanvasSize } }
  _setCanvasDevicePixelDimensions: (width: number, height: number) => void
}

// Routes the renderer's device-pixel resizes through canvasDeviceSize and
// reports the ones that really change the backing store. Returns false when the
// addon's internals are not the expected ones (left untouched).
export function guardWebglCanvasSize(
  addon: object,
  dpr: () => number = () => globalThis.devicePixelRatio || 1,
  onResize?: () => void,
): boolean {
  const renderer = (addon as { _renderer?: Partial<WebglRendererInternals> })._renderer
  const resize = renderer?._setCanvasDevicePixelDimensions
  if (!renderer || typeof resize !== 'function' || !renderer.dimensions?.device?.canvas) return false
  const r = renderer as WebglRendererInternals
  let last: CanvasSize | null = r._canvas ? { width: r._canvas.width, height: r._canvas.height } : null
  r._setCanvasDevicePixelDimensions = (width, height) => {
    const prev = r._canvas ? { width: r._canvas.width, height: r._canvas.height } : last
    const size = canvasDeviceSize({ width, height }, r.dimensions.device.canvas, dpr())
    resize.call(r, size.width, size.height)
    last = size
    if (!prev || prev.width !== size.width || prev.height !== size.height) onResize?.()
  }
  return true
}
