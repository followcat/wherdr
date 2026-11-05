// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDemoNetwork } from '../app/demo/shim'
import { CODEX, DEV_SERVER } from '../app/demo/scenario'
import { agentScreen } from '../app/demo/terminal'
import type { Pane } from '../shared/types'

const realFetch = window.fetch
const realSocket = window.WebSocket
const sockets: WebSocket[] = []
let server: ReturnType<typeof installDemoNetwork>

beforeEach(() => {
  vi.useFakeTimers()
  server = installDemoNetwork('/demo/')
})
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close()
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  window.fetch = realFetch
  window.WebSocket = realSocket
})

async function connect(route: string) {
  const socket = new window.WebSocket(`ws://localhost/ws/${route}`)
  sockets.push(socket)
  const frames: { type: string, width?: number, height?: number, cols?: number, rows?: number }[] = []
  socket.onmessage = e => frames.push(JSON.parse(e.data))
  await vi.advanceTimersByTimeAsync(25)
  return { socket, frames }
}

describe('demo terminal Markdown', () => {
  const pane = { agent: 'claude', status: 'idle', model: { label: 'Sonnet' } } as Pane
  const text = 'Three choices:\n\n| Choice | Behaviour |\n|---|---|\n| System | follows `prefers-color-scheme`, live |\n| Dark | **always** dark |\n\nSaved.'
  const lines = (cols: number) => agentScreen(pane, [{ role: 'assistant', text, ts: null }], '', cols, 60)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\r\n')

  it('draws a table as a grid, without the Markdown bars and marks', () => {
    const out = lines(100)
    expect(out.slice(3, 10)).toEqual([
      '  ┌────────┬────────────────────────────────────┐',
      '  │ Choice │ Behaviour                          │',
      '  ├────────┼────────────────────────────────────┤',
      '  │ System │ follows prefers-color-scheme, live │',
      '  ├────────┼────────────────────────────────────┤',
      '  │ Dark   │ always dark                        │',
      '  └────────┴────────────────────────────────────┘',
    ])
    expect(out.join('\n')).not.toMatch(/\|/)
    expect(out).toContain('  Saved.')
  })

  it('wraps the cells of a table wider than the screen', () => {
    const out = lines(40)
    const grid = out.filter(l => /[│┌├└]/.test(l))
    expect(grid.length).toBeGreaterThan(7)
    for (const l of grid) expect(l.length).toBeLessThanOrEqual(40)
    expect(new Set(grid.map(l => l.length)).size).toBe(1)
    // Nothing is dropped: a word longer than its column is cut over two rows.
    expect(grid.join('').replace(/[^a-z,-]/g, '')).toContain('followsprefers-color-scheme,live')
  })
})

describe('demo split terminal sizing', () => {
  it('streams the interactive usage screen and returns to the field through real terminal keys', async () => {
    await vi.advanceTimersByTimeAsync(30000)
    const sent = window.fetch('/api/prompt', { method: 'POST', body: JSON.stringify({ pane_id: CODEX, text: '/usage' }) })
    await vi.advanceTimersByTimeAsync(100)
    await sent
    const { socket, frames } = await connect(`term?pane=${CODEX}&cols=48&rows=30`)
    const text = () => atob((frames.at(-1) as unknown as { bytes: string }).bytes)
    expect(text()).toContain('View analytics  Usage history')
    socket.send(JSON.stringify({ type: 'keys', keys: ['down', 'enter'] }))
    expect(text()).toContain('Demo analytics')
    socket.send(JSON.stringify({ type: 'keys', keys: ['esc', 'esc'] }))
    await vi.advanceTimersByTimeAsync(100)
    expect(server.pane(CODEX)?.interaction).toBe('input')
    expect(text()).not.toContain('Demo analytics')
  })
  it('places a short Claude exchange at the top with its prompt directly after it', () => {
    const pane = { agent: 'claude', status: 'idle', model: { label: 'Sonnet' } } as Pane
    const screen = agentScreen(pane, [{ role: 'assistant', text: 'Done.', ts: null }], '', 100, 80)
    expect(screen).toContain('\x1b[H\r\n')
    expect(screen.split('\r\n')).toHaveLength(8)
    expect(screen).toContain('\x1b[6;3H')
  })
  it('fits the terminal and follows cell resizing', async () => {
    const { socket, frames } = await connect(`term?pane=${DEV_SERVER}&cols=113&rows=62`)
    expect(frames.at(-1)).toMatchObject({ type: 'terminal.frame', width: 113, height: 62 })
    socket.send(JSON.stringify({ type: 'terminal.resize', cols: 81, rows: 48 }))
    expect(frames.at(-1)).toMatchObject({ width: 81, height: 48 })
  })

  it('refuses the old mirror route', async () => {
    const { socket, frames } = await connect(`mirror?pane=${DEV_SERVER}`)
    expect(frames).toEqual([])
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  })
})
