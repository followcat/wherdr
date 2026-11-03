// Devin's ATIF transcript lands when a turn ends; the lifecycle-hook sidecar
// covers the in-flight part in real time. These tests pin the event->item
// mapping, the ATIF-boundary filter, and the install's idempotence.
import { describe, expect, it } from 'vitest'
import { type MachineFs, type ShellExec } from '../server/utils/fsx'
import { ensureDevinLive, livePath, parseLiveEvents } from '../server/utils/devinLive'

const T0 = Date.parse('2026-11-03T09:07:20.000Z')
const line = (ts: number, ev: Record<string, unknown>) => JSON.stringify({ ts, ev })

describe('Devin live tail: hook events to chat items', () => {
  it('renders the prompt the user just sent, newer than ATIF', () => {
    const raw = line(T0, { hook_event_name: 'UserPromptSubmit', prompt: 'still no image', session_id: 's1' })
    const items = parseLiveEvents(raw, T0 - 1)
    expect(items).toEqual([{ role: 'user', text: 'still no image', ts: new Date(T0).toISOString(), live: true }])
  })

  it('pairs a tool call with its result, in order per tool name', () => {
    const raw = [
      line(T0, { hook_event_name: 'PreToolUse', tool_name: 'exec', tool_input: { command: 'adb devices' } }),
      line(T0 + 100, { hook_event_name: 'PreToolUse', tool_name: 'read', tool_input: { file_path: '/tmp/x' } }),
      line(T0 + 200, { hook_event_name: 'PostToolUse', tool_name: 'exec', tool_response: 'List of devices\nemulator-1' }),
    ].join('\n')
    const items = parseLiveEvents(raw, 0)
    expect(items).toHaveLength(2)
    const adb = items[0]!
    expect(adb).toMatchObject({ role: 'tool', name: 'exec', text: 'adb devices', live: true, toolStatus: 'completed', out: 'List of devices\nemulator-1' })
    expect(items[1]).toMatchObject({ name: 'read', toolStatus: 'running' })
    expect(items[1]!.out).toBeUndefined()
  })

  it('keeps a tool result whose call scrolled out of the sidecar window', () => {
    const raw = line(T0, { hook_event_name: 'PostToolUse', tool_name: 'exec', tool_response: 'done' })
    const [item] = parseLiveEvents(raw, 0)
    expect(item).toMatchObject({ role: 'tool', name: 'exec', toolStatus: 'completed', out: 'done' })
  })

  it("renders the turn's last reply when Stop fires", () => {
    const raw = line(T0, { hook_event_name: 'Stop', last_assistant_message: 'all done', session_id: 's1' })
    const [item] = parseLiveEvents(raw, 0)
    expect(item).toMatchObject({ role: 'assistant', text: 'all done', live: true })
  })

  it('drops events ATIF has already exported (ts at or before its last step)', () => {
    const raw = [
      line(T0 - 5, { hook_event_name: 'UserPromptSubmit', prompt: 'old' }),
      line(T0, { hook_event_name: 'UserPromptSubmit', prompt: 'at boundary' }),
      line(T0 + 5, { hook_event_name: 'UserPromptSubmit', prompt: 'new' }),
    ].join('\n')
    const items = parseLiveEvents(raw, T0)
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe('new')
  })

  it('skips malformed lines and unrelated events, caps the tail', () => {
    const junk = ['not json', '{"ts":"x"}', line(T0, { hook_event_name: 'SessionStart' }), line(T0, { hook_event_name: 'PermissionRequest' })]
    const many = Array.from({ length: 50 }, (_, i) => line(T0 + i, { hook_event_name: 'UserPromptSubmit', prompt: `p${i}` }))
    const items = parseLiveEvents([...junk, ...many].join('\n'), 0)
    expect(items).toHaveLength(40)
    expect(items[0]!.text).toBe('p10')
    expect(items.every(i => i.role === 'user')).toBe(true)
  })
})

describe('Devin live tail: hook install', () => {
  const fsStub = {} as MachineFs
  const execOk = (calls: string[]): ShellExec => async (script) => { calls.push(script); return { code: 0, stdout: Buffer.from('installed\n'), stderr: '' } }

  it('installs once per filesystem, retries only after a failure interval', async () => {
    let t = 1000
    const calls: string[] = []
    await ensureDevinLive(fsStub, execOk(calls), () => t)
    await ensureDevinLive(fsStub, execOk(calls), () => t)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('wherdr-devin-live')
    expect(calls[0]).toContain('UserPromptSubmit')
    expect(calls[0]).toContain('config.json')
  })

  it('is a no-op without a shell channel (local machine)', async () => {
    const calls: string[] = []
    const fs2 = {} as MachineFs
    await ensureDevinLive(fs2, undefined, () => 0)
    expect(calls).toHaveLength(0)
  })

  it('retries after a failed attempt', async () => {
    let t = 5000
    const calls: string[] = []
    const fail: ShellExec = async (script) => { calls.push(script); return { code: 1, stdout: Buffer.alloc(0), stderr: 'no-python3' } }
    const fs3 = {} as MachineFs
    await ensureDevinLive(fs3, fail, () => t)
    await ensureDevinLive(fs3, fail, () => t)
    expect(calls).toHaveLength(1)
    t += 11 * 60 * 1000
    await ensureDevinLive(fs3, fail, () => t)
    expect(calls).toHaveLength(2)
  })
})

describe('Devin live tail: paths', () => {
  it('builds a per-session sidecar path under the machine cache dir', () => {
    expect(livePath('/home/u', 'verdant-feta')).toBe('/home/u/.cache/herdr-web/devin-live/verdant-feta.jsonl')
    expect(livePath('/home/u', 'bad/name')).toBeNull()
    expect(livePath('/home/u', '')).toBeNull()
  })
})
