import { describe, expect, it } from 'vitest'
import {
  activeTerminalRenderer,
  canvasDeviceSize,
  guardWebglCanvasSize,
  MAX_WEBGL_PIXELS,
  parseTerminalRenderer,
  webglBufferOf,
  webglBufferUnusable,
} from '../app/utils/terminalRenderer'

describe('terminal renderer preference', () => {
  it('defaults to WebGL when the preference is absent or invalid', () => {
    expect(parseTerminalRenderer(null)).toBe('webgl')
    expect(parseTerminalRenderer('')).toBe('webgl')
    expect(parseTerminalRenderer('canvas')).toBe('webgl')
  })

  it('restores the saved HTML choice', () => {
    expect(parseTerminalRenderer('html')).toBe('html')
    expect(parseTerminalRenderer('webgl')).toBe('webgl')
  })

  it('distinguishes the selected HTML renderer from a WebGL fallback', () => {
    expect(activeTerminalRenderer('html', true)).toBe('html')
    expect(activeTerminalRenderer('html', false)).toBe('html')
    expect(activeTerminalRenderer('webgl', true)).toBe('webgl')
    expect(activeTerminalRenderer('webgl', false)).toBe('html-fallback')
  })
})

describe('WebGL canvas backing store', () => {
  const expected = { width: 756, height: 832 } // 378 × 416 CSS px at DPR 2

  it('keeps a reported device size within rounding of CSS size × DPR', () => {
    expect(canvasDeviceSize({ width: 757, height: 831 }, expected, 2)).toEqual({ width: 757, height: 831 })
    expect(canvasDeviceSize({ width: 1135, height: 1248 }, { width: 1134, height: 1248 }, 3)).toEqual({ width: 1135, height: 1248 })
  })

  it('ignores a device size reported in CSS pixels', () => {
    expect(canvasDeviceSize({ width: 378, height: 416 }, expected, 2)).toEqual(expected)
    expect(canvasDeviceSize({ width: 378, height: 416 }, { width: 1134, height: 1248 }, 3)).toEqual({ width: 1134, height: 1248 })
    expect(canvasDeviceSize({ width: 756, height: 416 }, expected, 2)).toEqual(expected)
  })

  it('routes the renderer resizes through the guard and notifies only when the backing size changes', () => {
    const calls: number[][] = []
    let resized = 0
    const canvas = { width: 756, height: 832 }
    const renderer = {
      _canvas: canvas,
      dimensions: { device: { canvas: expected } },
      _setCanvasDevicePixelDimensions(w: number, h: number) {
        canvas.width = w
        canvas.height = h
        calls.push([w, h, this === renderer ? 1 : 0])
      },
    }
    expect(guardWebglCanvasSize({ _renderer: renderer }, () => 2, () => { resized++ })).toBe(true)
    renderer._setCanvasDevicePixelDimensions(378, 416)
    expect(resized).toBe(0)
    renderer._setCanvasDevicePixelDimensions(757, 832)
    expect(resized).toBe(1)
    renderer._setCanvasDevicePixelDimensions(757, 832)
    expect(resized).toBe(1)
    expect(calls).toEqual([[756, 832, 1], [757, 832, 1], [757, 832, 1]])
  })

  it('leaves an addon with other internals untouched', () => {
    expect(guardWebglCanvasSize({})).toBe(false)
    expect(guardWebglCanvasSize({ _renderer: { _setCanvasDevicePixelDimensions: () => {} } })).toBe(false)
  })
})

describe('WebGL drawing buffer check', () => {
  it('reads the canvas and GL drawing buffer sizes when present', () => {
    expect(webglBufferOf({})).toBeNull()
    expect(webglBufferOf({ _renderer: { _canvas: { width: 1400, height: 1920 } } })).toBeNull()
    expect(webglBufferOf({
      _renderer: {
        _canvas: { width: 5600, height: 7680 },
        _gl: { drawingBufferWidth: 4918, drawingBufferHeight: 6745 },
      },
    })).toEqual({
      width: 5600,
      height: 7680,
      drawingBufferWidth: 4918,
      drawingBufferHeight: 6745,
    })
  })

  it('flags clamped buffers and canvases exceeding the safe pixel cap', () => {
    expect(MAX_WEBGL_PIXELS).toBe(16_777_216)
    expect(webglBufferUnusable({ width: 0, height: 0, drawingBufferWidth: 0, drawingBufferHeight: 0 })).toBe(false)
    expect(webglBufferUnusable({ width: 1400, height: 1920, drawingBufferWidth: 1398, drawingBufferHeight: 1919 })).toBe(false)
    // Clamped drawing buffer (Chrome on DPR 4 phone).
    expect(webglBufferUnusable({ width: 5600, height: 7680, drawingBufferWidth: 4918, drawingBufferHeight: 6745 })).toBe(true)
    expect(webglBufferUnusable({ width: 3200, height: 4000, drawingBufferWidth: 2800, drawingBufferHeight: 4000 })).toBe(true)
    // Over MAX_WEBGL_PIXELS even without clamping (iOS Safari cap).
    expect(webglBufferUnusable({ width: 5600, height: 7680, drawingBufferWidth: 5600, drawingBufferHeight: 7680 })).toBe(true)
  })
})
