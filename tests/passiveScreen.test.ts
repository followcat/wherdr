import { describe, expect, it, vi } from 'vitest'
import { readPassiveScreen } from '../server/utils/passiveScreen'
import { createSelfUpdates } from '../server/utils/agentSelfUpdate'
import type { Pane } from '../shared/types'

const OUTPUT = 'Codex CLI 0.162.1 installed successfully.\n\n🎉 Update ran successfully! Please restart Codex.\n\nuser@host project % '
const wrap = (text: string, columns: number) => text.split('\n').map(line =>
  Array.from(line).reduce<string[]>((rows, ch, i) => {
    if (i % columns === 0) rows.push('')
    rows[rows.length - 1] += ch
    return rows
  }, []).join('\n')).join('\n')

// Socket text reads harvest application history only for an idle agent in
// the alternate screen with mouse capture and a request taller than the screen.
// Normal-screen history is retained independently of the user's viewport.
function terminal(options: { alternate?: boolean, idle?: boolean, mouse?: boolean, height?: number } = {}) {
  let alternate = options.alternate ?? true
  const idle = options.idle ?? true
  const mouse = options.mouse ?? true
  const height = options.height ?? 24
  let shell = false
  let offset = 42
  let scrolls = 0
  const reads: { source: unknown, shell: boolean }[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'pane.read') {
      const recent = params.source === 'recent' || params.source === 'recent_unwrapped'
      reads.push({ source: params.source, shell })
      if (recent && Number(params.lines ?? 80) > height && alternate && mouse && idle && !shell) {
        scrolls++
        offset = 0
      }
      const text = !shell ? 'Codex ready'
        : recent ? (params.source === 'recent_unwrapped' ? OUTPUT : wrap(OUTPUT, 30))
          : offset ? 'Earlier shell output' : wrap(OUTPUT, 30)
      return { read: { text } }
    }
    return { process_info: { shell_pid: 2000, foreground_process_group_id: shell ? 2000 : 2001,
      foreground_processes: shell ? [{ pid: 2000, name: 'zsh' }]
        : [{ pid: 2001, name: 'codex', argv: ['codex'] }] } }
  })
  return { call, reads, offset: () => offset, scrolls: () => scrolls,
    scroll: (value: number) => { offset = value },
    exit: () => { shell = true; alternate = false } }
}

const pane = (agent: string | null = 'codex') => ({ id: 'w1:p1', workspace: 'w1', agent,
  agentSession: null, bornAt: 9000, status: 'idle', cwd: '/tmp/project' }) as Pane

function setup() {
  const t = terminal()
  let now = 10000
  const monitor = createSelfUpdates({ call: t.call, now: () => now, sleep: async () => {},
    chat: async () => ({ available: false, reason: 'not_found' }) })
  return { t, monitor, tick: () => { now += 5000 } }
}

describe('passive terminal status reads', () => {
  it.each(['recent', 'recent_unwrapped'])('models history harvesting for %s', async source => {
    const t = terminal()
    await t.call('pane.read', { source, lines: 80 })
    expect(t.scrolls()).toBe(1)
  })
  it.each([
    { alternate: false }, { idle: false }, { mouse: false }, { height: 80 },
  ])('does not harvest when a required condition is absent: %j', async options => {
    const t = terminal(options)
    await t.call('pane.read', { source: 'recent_unwrapped', lines: 80 })
    expect(t.scrolls()).toBe(0)
    expect(t.offset()).toBe(42)
  })
  it('reads status without navigating the existing viewport', async () => {
    const t = terminal()
    expect(await readPassiveScreen(t.call, 'w1:p1')).toBe('Codex ready')
    expect(t.offset()).toBe(42)
    expect(t.scrolls()).toBe(0)
  })
  it('uses only visible snapshots for repeated live idle Codex observations', async () => {
    const { t, monitor, tick } = setup()
    for (let i = 0; i < 8; i++) { await monitor.observe(pane(), false); tick() }
    expect(t.reads).toEqual(Array.from({ length: 8 }, () => ({ source: 'visible', shell: false })))
    expect(t.offset()).toBe(42)
    expect(t.scrolls()).toBe(0)
  })
  it.each([0, 42])('finds installer output in a 30-column shell at offset %i', async offset => {
    const { t, monitor, tick } = setup()
    await monitor.observe(pane(), false)
    t.exit()
    t.scroll(offset)
    // visible is wrapped (or shows older output); shell history is unwrapped.
    const visible = await t.call('pane.read', { source: 'visible' })
    if (offset) expect(visible.read!.text).toBe('Earlier shell output')
    else expect(visible.read!.text).toContain('installed su\nccessfully.')
    await monitor.observe(pane(null), false)
    tick()
    const stopped = pane(null)
    expect(await monitor.observe(stopped, false)).toBe(true)
    expect(stopped.stopped).toEqual({ reason: 'update' })
    t.scroll(42)
    expect(await monitor.check(stopped.id)).not.toBeNull()
    expect(t.reads.filter(r => r.shell && r.source !== 'visible')).toEqual([
      { source: 'recent_unwrapped', shell: true }, { source: 'recent_unwrapped', shell: true },
    ])
    expect(t.offset()).toBe(42)
    expect(t.scrolls()).toBe(0)
  })
})
