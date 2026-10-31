import { describe, expect, it } from 'vitest'
import { activeTerminalRenderer, canvasDeviceSize, guardWebglCanvasSize, parseTerminalRenderer } from '../app/utils/terminalRenderer'

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

  it('routes the renderer resizes through the guard', () => {
    const calls: number[][] = []
    const renderer = {
      dimensions: { device: { canvas: expected } },
      _setCanvasDevicePixelDimensions(w: number, h: number) { calls.push([w, h, this === renderer ? 1 : 0]) },
    }
    expect(guardWebglCanvasSize({ _renderer: renderer }, () => 2)).toBe(true)
    renderer._setCanvasDevicePixelDimensions(378, 416)
    renderer._setCanvasDevicePixelDimensions(757, 832)
    expect(calls).toEqual([[756, 832, 1], [757, 832, 1]])
  })

  it('leaves an addon with other internals untouched', () => {
    expect(guardWebglCanvasSize({})).toBe(false)
    expect(guardWebglCanvasSize({ _renderer: { _setCanvasDevicePixelDimensions: () => {} } })).toBe(false)
  })
})
