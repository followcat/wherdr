// Devin's ATIF transcript lands when a turn ends; the lifecycle-hook sidecar
// covers the in-flight part in real time. These tests pin the event->item
// mapping, the ATIF-boundary filter, and the install's idempotence.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('pairs a tool result with its own call by tool_use_id, out of order', () => {
    const raw = [
      line(T0, { hook_event_name: 'PreToolUse', tool_name: 'exec', tool_use_id: 'call-a', tool_input: { command: 'first' } }),
      line(T0 + 100, { hook_event_name: 'PreToolUse', tool_name: 'exec', tool_use_id: 'call-b', tool_input: { command: 'second' } }),
      line(T0 + 200, { hook_event_name: 'PostToolUse', tool_name: 'exec', tool_use_id: 'call-b', tool_response: 'out-b' }),
      line(T0 + 300, { hook_event_name: 'PostToolUse', tool_name: 'exec', tool_use_id: 'call-a', tool_response: 'out-a' }),
    ].join('\n')
    const items = parseLiveEvents(raw, 0)
    expect(items[0]).toMatchObject({ text: 'first', toolStatus: 'completed', out: 'out-a' })
    expect(items[1]).toMatchObject({ text: 'second', toolStatus: 'completed', out: 'out-b' })
  })

  it('keeps per-name order when a PostToolUse has no tool_use_id', () => {
    const raw = [
      line(T0, { hook_event_name: 'PreToolUse', tool_name: 'exec', tool_use_id: 'call-a', tool_input: { command: 'with-id' } }),
      line(T0 + 100, { hook_event_name: 'PreToolUse', tool_name: 'exec', tool_input: { command: 'no-id' } }),
      line(T0 + 200, { hook_event_name: 'PostToolUse', tool_name: 'exec', tool_response: 'done' }),
    ].join('\n')
    const items = parseLiveEvents(raw, 0)
    expect(items[0]).toMatchObject({ text: 'with-id', toolStatus: 'completed', out: 'done' })
    expect(items[1]).toMatchObject({ text: 'no-id', toolStatus: 'running' })
  })

  it('keeps a tool result whose call scrolled out of the sidecar window', () => {
    const raw = line(T0, { hook_event_name: 'PostToolUse', tool_name: 'exec', tool_response: 'done' })
    const [item] = parseLiveEvents(raw, 0)
    expect(item).toMatchObject({ role: 'tool', name: 'exec', toolStatus: 'completed', out: 'done' })
  })

  it('reads a real object tool_response: output text, or error marked as an error', () => {
    // Devin 3000.11.234 sends {output, error, success}, not a plain string.
    const raw = [
      line(T0, { hook_event_name: 'PreToolUse', tool_name: 'exec', tool_use_id: 'c1', tool_input: { command: 'make check' } }),
      line(T0 + 100, { hook_event_name: 'PostToolUse', tool_name: 'exec', tool_use_id: 'c1', tool_response: { output: 'ran fine', error: null, success: true } }),
      line(T0 + 200, { hook_event_name: 'PostToolUse', tool_name: 'exec', tool_response: { output: '', error: 'exit 1: boom', success: false } }),
      line(T0 + 300, { hook_event_name: 'PostToolUse', tool_name: 'exec', tool_response: { success: true } }),
    ].join('\n')
    const items = parseLiveEvents(raw, 0)
    expect(items[0]).toMatchObject({ text: 'make check', toolStatus: 'completed', out: 'ran fine' })
    expect(items[0]!.error).toBeUndefined()
    expect(items[1]).toMatchObject({ role: 'tool', toolStatus: 'completed', out: 'exit 1: boom', error: true })
    // Neither output nor error to show: the raw object is the fallback.
    expect(items[2]).toMatchObject({ role: 'tool', toolStatus: 'completed', out: '{"success":true}' })
  })

  it('lets a result with an unknown tool_use_id orphan instead of taking a waiting call', () => {
    // id0's own PreToolUse scrolled out of the tail: it must not complete
    // id1's call with the wrong output.
    const raw = [
      line(T0, { hook_event_name: 'PreToolUse', tool_name: 'exec', tool_use_id: 'id1', tool_input: { command: 'still running' } }),
      line(T0 + 100, { hook_event_name: 'PostToolUse', tool_name: 'exec', tool_use_id: 'id0', tool_response: { output: 'older', error: null, success: true } }),
    ].join('\n')
    const items = parseLiveEvents(raw, 0)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ text: 'still running', toolStatus: 'running' })
    expect(items[0]!.out).toBeUndefined()
    expect(items[1]).toMatchObject({ role: 'tool', toolStatus: 'completed', out: 'older' })
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

// The install script and the hook run on the Devin machine: exercise them for
// real, under a temporary HOME — never the developer's own ~/.config/devin.
describe('Devin live tail: install on a real shell', () => {
  const dirs: string[] = []
  const home = () => {
    const h = mkdtempSync(path.join(tmpdir(), 'wherdr-live-'))
    dirs.push(h)
    return h
  }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  const installScript = async () => {
    const calls: string[] = []
    await ensureDevinLive({} as MachineFs, async (script) => { calls.push(script); return { code: 0, stdout: Buffer.alloc(0), stderr: '' } })
    return calls[0]!
  }
  const sh = (script: string, homeDir: string) =>
    spawnSync('sh', ['-c', script], { env: { ...process.env, HOME: homeDir }, encoding: 'utf8' })
  const wherdrEntries = (cfg: Record<string, any>, event: string) =>
    ((cfg.hooks?.[event] || []) as any[]).filter(e => JSON.stringify(e).includes('wherdr-devin-live'))

  it('leaves an unparsable config byte-identical and fails', async () => {
    const h = home()
    const cfgd = path.join(h, '.config/devin')
    mkdirSync(cfgd, { recursive: true })
    const cfg = path.join(cfgd, 'config.json')
    const broken = '{\n  // half-written, keep out\n  "hooks": {},\n'
    writeFileSync(cfg, broken)
    const r = sh(await installScript(), h)
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}\n${r.stderr}`).toContain('bad-config')
    expect(readFileSync(cfg, 'utf8')).toBe(broken)
  })

  it('keeps every existing key and hook, adds one wherdr entry per event, and stays idempotent', async () => {
    const h = home()
    const cfgd = path.join(h, '.config/devin')
    mkdirSync(cfgd, { recursive: true })
    const cfg = path.join(cfgd, 'config.json')
    writeFileSync(cfg, JSON.stringify({
      model: 'fusion',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'herdr-agent-state.sh devin stop' }] }],
        PostCompaction: [{ hooks: [{ type: 'command', command: 'herdr-agent-state.sh devin compact' }] }],
      },
    }))
    chmodSync(cfg, 0o640)
    const script = await installScript()
    expect(sh(script, h).status).toBe(0)
    const cfg1 = JSON.parse(readFileSync(cfg, 'utf8'))
    expect(cfg1.model).toBe('fusion')
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'])
      expect(wherdrEntries(cfg1, event)).toHaveLength(1)
    // Herdr's own hook is still there, including on PostCompaction: the
    // installer only stops registering wherdr's hook for it, it never strips
    // entries a config already has.
    expect(JSON.stringify(cfg1.hooks.Stop)).toContain('herdr-agent-state.sh')
    expect(JSON.stringify(cfg1.hooks.PostCompaction)).toContain('herdr-agent-state.sh')
    expect(wherdrEntries(cfg1, 'PostCompaction')).toHaveLength(0)
    expect(statSync(cfg).mode & 0o777).toBe(0o640)
    const before = readFileSync(cfg, 'utf8')
    expect(sh(script, h).status).toBe(0)
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })

  it('creates a missing config as mode 0600', async () => {
    const h = home()
    expect(sh(await installScript(), h).status).toBe(0)
    const cfg = path.join(h, '.config/devin/config.json')
    const d = JSON.parse(readFileSync(cfg, 'utf8'))
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'])
      expect(wherdrEntries(d, event)).toHaveLength(1)
    expect(d.hooks.PostCompaction).toBeUndefined()
    expect(statSync(cfg).mode & 0o777).toBe(0o600)
  })

  it('deletes sidecars untouched for a week, keeps fresh ones', async () => {
    const h = home()
    const dir = path.join(h, '.cache/herdr-web/devin-live')
    mkdirSync(dir, { recursive: true })
    const stale = path.join(dir, 'ended-session.jsonl')
    const fresh = path.join(dir, 'live-session.jsonl')
    writeFileSync(stale, '{}\n')
    writeFileSync(fresh, '{}\n')
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    utimesSync(stale, eightDaysAgo, eightDaysAgo)
    expect(sh(await installScript(), h).status).toBe(0)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  // Feeds one event JSON to the installed hook, like Devin itself does.
  const hook = (homeDir: string, ev: Record<string, unknown>, extraEnv: Record<string, string> = {}) =>
    spawnSync('python3', [path.join(homeDir, '.config/devin/wherdr-devin-live.py')], {
      env: { ...process.env, HOME: homeDir, ...extraEnv },
      input: JSON.stringify(ev),
      encoding: 'utf8',
    })

  it('writes the sidecar under ~/.cache even when XDG_CACHE_HOME is set, mode 0600', async () => {
    const h = home()
    expect(sh(await installScript(), h).status).toBe(0)
    const xdg = path.join(h, 'elsewhere')
    // The reader builds ~/.cache/herdr-web from the machine's home: it cannot
    // know a remote XDG_CACHE_HOME, so the hook ignores it too.
    expect(hook(h, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' }, { XDG_CACHE_HOME: xdg }).status).toBe(0)
    const sidecar = path.join(h, '.cache/herdr-web/devin-live/s1.jsonl')
    expect(existsSync(sidecar)).toBe(true)
    expect(existsSync(path.join(xdg, 'herdr-web/devin-live/s1.jsonl'))).toBe(false)
    expect(statSync(sidecar).mode & 0o777).toBe(0o600)
  })

  it('truncates prompts, replies, tool output and inputs before writing', async () => {
    const h = home()
    expect(sh(await installScript(), h).status).toBe(0)
    const r = hook(h, {
      hook_event_name: 'PostToolUse', session_id: 's2',
      prompt: 'p'.repeat(25000),
      last_assistant_message: 'a'.repeat(25000),
      tool_response: 'o'.repeat(5000),
      tool_input: { command: 'c'.repeat(2000), timeout: 42 },
    })
    expect(r.status).toBe(0)
    const rec = JSON.parse(readFileSync(path.join(h, '.cache/herdr-web/devin-live/s2.jsonl'), 'utf8'))
    expect(rec.ev.prompt).toHaveLength(20000)
    expect(rec.ev.last_assistant_message).toHaveLength(20000)
    expect(rec.ev.tool_response).toHaveLength(4000)
    expect(rec.ev.tool_input.command).toHaveLength(1000)
    expect(rec.ev.tool_input.timeout).toBe('42')
  })

  it('clips a real object tool_response field by field', async () => {
    const h = home()
    expect(sh(await installScript(), h).status).toBe(0)
    // Devin 3000.11.234 sends {output, error, success}: the text fields clip,
    // the rest is kept as is.
    const r = hook(h, {
      hook_event_name: 'PostToolUse', session_id: 's3', tool_name: 'exec', tool_use_id: 'call-1',
      tool_response: { output: 'o'.repeat(10000), error: null, success: true },
    })
    expect(r.status).toBe(0)
    const rec = JSON.parse(readFileSync(path.join(h, '.cache/herdr-web/devin-live/s3.jsonl'), 'utf8'))
    expect(rec.ev.tool_response.output).toHaveLength(4000)
    expect(rec.ev.tool_response.error).toBeNull()
    expect(rec.ev.tool_response.success).toBe(true)
  })
})
