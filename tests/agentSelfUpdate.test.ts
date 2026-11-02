import { describe, expect, it, vi } from 'vitest'
import { updateChoices, updateRestartPlan, updateShellSignature } from '../shared/selfUpdate'
import { AT_SAVE_MS, createSelfUpdates } from '../server/utils/agentSelfUpdate'
import type { ChatResponse, Pane } from '../shared/types'

const SESSION = '00000000-0000-4000-8000-000000000288'
const OUTPUT = 'Updating Codex via installer...\nCodex CLI 0.162.1 installed successfully.\n\n🎉 Update ran successfully! Please restart Codex.\n\nuser@host project % '
const PROMPTS = ['user@host:~/dir$ ', 'root@host:~/dir# ', '# ', 'user@host dir % ', '$ ', '% ']
const wrap = (text: string, columns: number) => text.split('\n').map(line => {
  const chars = Array.from(line)
  const rows: string[] = []
  for (let i = 0; i < chars.length; i += columns) rows.push(chars.slice(i, i + columns).join(''))
  return rows.join('\n')
}).join('\n')
const pane = (agent: string | null = 'codex') => ({ id: 'w1:p1', workspace: 'w1', agent, agentSession: null, bornAt: 9000, status: 'idle', cwd: '/tmp/project' }) as Pane

describe('Codex self-update output', () => {
  describe.each([80, 32])('%i terminal columns', columns => {
    it.each(PROMPTS)('recognizes an empty shell prompt: %s', prompt => {
      const output = wrap(OUTPUT.replace('user@host project % ', prompt), columns)
      expect(updateShellSignature(output)).toBe(prompt.trimEnd())
    })
    it.each(['the total is 10$', 'ordinary output $', 'ordinary output %', 'ordinary output #',
      'user@host:~/dir$ echo hello', 'user@host dir % echo hello'])('rejects output or a draft: %s', line => {
      expect(updateShellSignature(wrap(OUTPUT.replace('user@host project % ', line), columns))).toBeNull()
    })
  })
  it('accepts the real installer ending and a multiline prompt', () => {
    expect(updateShellSignature(OUTPUT)).toBe('user@host project %')
    expect(updateShellSignature(OUTPUT.replace('user@host project % ', 'project on main\n❯ '))).toBe('project on main\n❯')
  })
  it.each([
    OUTPUT + 'echo hello', OUTPUT + 'echo #', OUTPUT + 'echo >',
    OUTPUT + "echo '\n> ", OUTPUT + 'cat <<EOF\n> ',
    OUTPUT.replace('user@host project % ', 'arbitrary output\n❯ '),
    OUTPUT.replace('user@host project % ', '> '),
    OUTPUT.replace('user@host project % ', '❯ echo %'),
    OUTPUT + '\nsome subsequent output',
    OUTPUT.replace('Codex CLI 0.162.1 installed successfully.', 'a quoted example'),
    OUTPUT.replace('🎉 Update ran', '> 🎉 Update ran'),
    OUTPUT.replace('user@host project % ', ''),
    'Update available! Please restart Codex.',
  ])('rejects a draft, a quote, an incomplete or stale ending', text => {
    expect(updateShellSignature(text)).toBeNull()
  })
})

describe('conversation choice', () => {
  const argv = ['codex', '-m', 'gpt-x', '--profile', 'work', '-C', '/tmp/project']
  it('replays the original startup command for a new conversation', () => {
    const launch = { argv: [...argv, 'Initial task'], session: null, conversation: 'empty' as const }
    expect(updateChoices(launch)).toEqual(['restart'])
    expect(updateRestartPlan(launch, 'restart').args).toEqual(launch.argv.slice(1))
  })
  it('resumes the exact transcript with its original launch options', () => {
    const launch = { argv: [...argv, 'resume', '--last'], session: SESSION, conversation: 'existing' as const }
    expect(updateChoices(launch)).toEqual(['resume', 'fresh'])
    expect(updateRestartPlan(launch, 'resume').args).toEqual(['resume', ...argv.slice(1), SESSION])
    expect(updateRestartPlan(launch, 'fresh').args).toEqual(argv.slice(1))
  })
  it('offers both choices when uncertain, opens a picker rather than --last', () => {
    const launch = { argv: null, session: null, conversation: 'unknown' as const }
    expect(updateChoices(launch)).toEqual(['resume', 'fresh'])
    expect(updateRestartPlan(launch, 'resume').args).toEqual(['resume'])
    expect(updateRestartPlan(launch, 'fresh').args).toEqual([])
    expect(updateChoices({ argv: ['codex', 'resume', '--last'], session: null, conversation: 'empty' })).toEqual(['resume', 'fresh'])
  })
})

function setup(chat: ChatResponse = { available: false, reason: 'not_found' }) {
  let now = 10000
  let shell = false
  let output = ''
  let pid = 2001
  let argv = ['codex', '--profile', 'work']
  const call = vi.fn(async (method: string) => method === 'pane.read'
    ? { read: { text: output } }
    : { process_info: { shell_pid: 2000, foreground_process_group_id: shell ? 2000 : pid,
        foreground_processes: shell ? [{ pid: 2000, name: 'zsh' }] : [{ pid, name: 'codex', argv }] } })
  const save = vi.fn()
  const deps = { call, sleep: async () => {}, now: () => now, chat: async () => chat, save }
  const monitor = createSelfUpdates(deps)
  return { monitor, deps, call, save, tick: (ms = 5000) => { now += ms }, exit: () => { shell = true; output = OUTPUT },
    replace: (args: string[]) => { pid++; argv = args },
    output: (text: string) => { output = text }, foreground: () => { shell = false; pid++ } }
}

describe('observed process lifecycle and final guards', () => {
  it('offers resume and fresh after an Ubuntu shell returns with wrapped installer output', async () => {
    const s = setup({ available: true, session: SESSION, items: [{ role: 'user', text: 'Continue', ts: null }] })
    await s.monitor.observe(pane(), false)
    s.exit()
    s.output(wrap(OUTPUT.replace('user@host project % ', 'user@host:~/dir$ '), 32))
    await s.monitor.observe(pane(null), false)
    s.tick()
    const stopped = pane(null)
    expect(await s.monitor.observe(stopped, false)).toBe(true)
    expect(stopped.prompt?.options.map(o => o.label)).toEqual(['Resume conversation', 'Start fresh'])
    expect(await s.monitor.check(stopped.id)).not.toBeNull()
  })
  it('keeps the pane blocked after exit, and validates the current empty shell', async () => {
    const s = setup()
    await s.monitor.observe(pane(), false)
    s.exit()
    expect(await s.monitor.observe(pane(null), false)).toBe(false)
    s.tick()
    const stopped = pane(null)
    expect(await s.monitor.observe(stopped, false)).toBe(true)
    expect(stopped).toMatchObject({ agent: 'codex', status: 'blocked', stopped: { reason: 'update' }, prompt: { options: [{ label: 'Restart Codex' }] } })
    expect(await s.monitor.check(stopped.id)).not.toBeNull()
    s.output(OUTPUT + 'echo hello')
    expect(await s.monitor.check(stopped.id)).toBeNull()
    s.output(OUTPUT)
    s.foreground()
    expect(await s.monitor.check(stopped.id)).toBeNull()
  })
  it('uses a verified transcript instead of a potentially incorrect Herdr session', async () => {
    const s = setup({ available: true, session: SESSION, items: [{ role: 'user', text: 'Hello', ts: null }] })
    await s.monitor.observe(pane(), false)
    expect(s.monitor.get('w1:p1')).toMatchObject({ session: SESSION, conversation: 'existing' })
  })
  it('forgets the previous conversation when the same process starts a new session', async () => {
    const chat: ChatResponse = { available: true, session: SESSION, items: [{ role: 'user', text: 'Hello', ts: null }] }
    const s = setup(chat)
    await s.monitor.observe(pane(), false)
    chat.session = '00000000-0000-4000-8000-000000000289'
    chat.items = []
    s.tick()
    await s.monitor.observe(pane(), false)
    expect(s.monitor.get('w1:p1')).toMatchObject({ session: chat.session, conversation: 'empty' })
  })
  it('refreshes a reported session change immediately, before the polling throttle', async () => {
    const chat: ChatResponse = { available: true, session: SESSION, items: [] }
    const s = setup(chat)
    await s.monitor.observe(pane(), false)
    chat.items = [{ role: 'user', text: 'Continue the task', ts: null }]
    await s.monitor.observe({ ...pane(), agentSession: SESSION }, false)
    expect(s.monitor.get('w1:p1')?.conversation).toBe('existing')
  })
  it('checks messages written between the last live sample and the exit', async () => {
    const chat: ChatResponse = { available: true, session: SESSION, items: [] }
    const s = setup(chat)
    await s.monitor.observe(pane(), false)
    chat.items = [{ role: 'user', text: 'Finish this task', ts: null }]
    s.exit()
    await s.monitor.observe(pane(null), false)
    s.tick()
    const stopped = pane(null)
    await s.monitor.observe(stopped, false)
    expect(stopped.prompt?.options.map(o => o.label)).toEqual(['Resume conversation', 'Start fresh'])
    expect(s.monitor.get(stopped.id)?.session).toBe(SESSION)
  })
  it('does not claim that a failed transcript read means an empty conversation', async () => {
    const s = setup()
    s.deps.chat = async () => { throw new Error('offline') }
    const m = createSelfUpdates(s.deps)
    await m.observe(pane(), false)
    expect(m.get('w1:p1')?.conversation).toBe('unknown')
  })
  it.each(["echo '\n> ", 'cat <<EOF\n> '])('rejects a multiline draft entered before the delayed exit check: %s', async draft => {
    const s = setup()
    await s.monitor.observe(pane(), false)
    s.exit()
    s.output(OUTPUT + draft)
    await s.monitor.observe(pane(null), false)
    s.tick()
    const stopped = pane(null)
    expect(await s.monitor.observe(stopped, false)).toBe(false)
    expect(stopped.stopped).toBeUndefined()
    expect(await s.monitor.check(stopped.id)).toBeNull()
  })
  it('invalidates exact A when guessed B is observed, even if the final read fails', async () => {
    const chat: ChatResponse = { available: true, session: SESSION, items: [{ role: 'user', text: 'Conversation A', ts: null }] }
    const s = setup(chat)
    await s.monitor.observe({ ...pane(), agentSession: SESSION }, false)
    chat.session = '00000000-0000-4000-8000-000000000289'
    chat.guessed = true
    chat.items = [{ role: 'user', text: 'Conversation B', ts: null }]
    await s.monitor.observe(pane(), false)
    expect(s.monitor.get('w1:p1')?.session).toBeNull()
    s.deps.chat = async () => { throw new Error('final read failed') }
    s.exit()
    await s.monitor.observe(pane(null), false)
    s.tick()
    const stopped = pane(null)
    await s.monitor.observe(stopped, false)
    expect(stopped.prompt?.options.map(o => o.label)).toEqual(['Resume conversation', 'Start fresh'])
    expect(updateRestartPlan(s.monitor.get(stopped.id)!, 'resume').args).toEqual(['resume', '--profile', 'work'])
  })
  it('offers both choices when the final read fails after a successful empty observation', async () => {
    const s = setup({ available: true, session: SESSION, items: [] })
    await s.monitor.observe(pane(), false)
    expect(s.monitor.get('w1:p1')?.conversation).toBe('empty')
    s.deps.chat = async () => { throw new Error('first messages are unreadable') }
    s.exit()
    await s.monitor.observe(pane(null), false)
    s.tick()
    const stopped = pane(null)
    await s.monitor.observe(stopped, false)
    expect(s.monitor.get(stopped.id)?.conversation).toBe('unknown')
    expect(stopped.prompt?.options.map(o => o.label)).toEqual(['Resume conversation', 'Start fresh'])
    expect(updateRestartPlan(s.monitor.get(stopped.id)!, 'resume').args).toEqual(['resume', '--profile', 'work', SESSION])
  })
  it.each([false, true])('captures a replacement process inside the throttle (birth changed: %s)', async birthChanged => {
    const s = setup()
    await s.monitor.observe(pane(), false)
    s.tick(1000)
    s.replace(['codex', '--profile', 'second', 'second task'])
    await s.monitor.observe({ ...pane(), ...(birthChanged ? { bornAt: 11000 } : {}) }, false)
    expect(s.monitor.get('w1:p1')?.pid).toBe(2002)
    s.exit()
    await s.monitor.observe(pane(null), false)
    s.tick()
    await s.monitor.observe(pane(null), false)
    expect(updateRestartPlan(s.monitor.get('w1:p1')!, 'restart').args).toEqual(['--profile', 'second', 'second task'])
  })
  it('does not infer an empty session when attaching to an already running Codex', async () => {
    const s = setup()
    await s.monitor.observe({ ...pane(), bornAt: undefined }, false)
    expect(s.monitor.get('w1:p1')?.conversation).toBe('unknown')
  })
  it('never triggers on a quote while Codex is alive, or in an unrelated shell pane', async () => {
    const s = setup()
    s.output(OUTPUT)
    expect(await s.monitor.observe(pane(), false)).toBe(false)
    expect(await setup().monitor.observe(pane(null), false)).toBe(false)
    s.exit()
    await s.monitor.observe(pane(null), false)
    s.tick()
    expect(await s.monitor.observe(pane(null), false)).toBe(false)
  })
  it('checks exit only once: printing an old update later does not trigger', async () => {
    const s = setup()
    await s.monitor.observe(pane(), false)
    s.exit()
    s.output('user@host project % ')
    await s.monitor.observe(pane(null), false)
    s.tick()
    expect(await s.monitor.observe(pane(null), false)).toBe(false)
    s.output(OUTPUT)
    s.tick()
    expect(await s.monitor.observe(pane(null), false)).toBe(false)
  })
  it('ignores wherdr-owned restarts and prunes removed panes', async () => {
    const s = setup()
    expect(await s.monitor.observe(pane(), true)).toBe(false)
    expect(s.call).not.toHaveBeenCalled()
    await s.monitor.observe(pane(), false)
    s.monitor.prune(new Set(), () => true)
    expect(s.monitor.get('w1:p1')).toBeUndefined()
  })
  it('retains the original command and pending card across a service restart', async () => {
    const s = setup()
    await s.monitor.observe(pane(), false)
    s.exit()
    await s.monitor.observe(pane(null), false)
    s.tick()
    await s.monitor.observe(pane(null), false)
    const restored = createSelfUpdates(s.deps, JSON.parse(JSON.stringify([['w1:p1', s.monitor.get('w1:p1')]])))
    expect(await restored.observe(pane(null), false)).toBe(true)
    expect((await restored.check('w1:p1'))?.argv).toEqual(['codex', '--profile', 'work'])
  })
  it('does not arm old live records after a long service outage', async () => {
    const s = setup()
    await s.monitor.observe(pane(), false)
    const saved = JSON.parse(JSON.stringify([['w1:p1', s.monitor.get('w1:p1')]]))
    // Longer than the saved time may be late, plus a short outage.
    for (let i = 0; i < 16; i++) s.tick()
    const restored = createSelfUpdates(s.deps, saved)
    s.exit()
    await restored.observe(pane(null), false)
    s.tick()
    expect(await restored.observe(pane(null), false)).toBe(false)
  })
  it('flags the pane while the exit is being checked, and only then', async () => {
    const s = setup()
    const alive = pane()
    await s.monitor.observe(alive, false)
    expect(alive.leaving).toBeUndefined()
    s.exit()
    const gone = pane(null)
    expect(await s.monitor.observe(gone, false)).toBe(false)
    expect(gone.leaving).toBe(true)
    s.tick(2000)
    const waiting = pane(null)
    await s.monitor.observe(waiting, false)
    expect(waiting.leaving).toBe(true)
    s.tick(1000)
    const stopped = pane(null)
    expect(await s.monitor.observe(stopped, false)).toBe(true)
    expect(stopped.leaving).toBeUndefined()
  })
  it('stops flagging a plain exit once its screen is checked', async () => {
    const s = setup()
    await s.monitor.observe(pane(), false)
    s.exit()
    s.output('user@host project % ')
    await s.monitor.observe(pane(null), false)
    s.tick()
    const shell = pane(null)
    expect(await s.monitor.observe(shell, false)).toBe(false)
    expect(shell.leaving).toBeUndefined()
  })
  it('forgets a dismissed card for good: the pane stays a plain shell', async () => {
    const s = setup()
    await s.monitor.observe(pane(), false)
    s.exit()
    await s.monitor.observe(pane(null), false)
    s.tick()
    expect(await s.monitor.observe(pane(null), false)).toBe(true)
    s.monitor.clear('w1:p1')
    expect(s.save).toHaveBeenLastCalledWith([])
    const reads = s.call.mock.calls.length
    for (let i = 0; i < 3; i++) {
      s.tick()
      const shell = pane(null)
      expect(await s.monitor.observe(shell, false)).toBe(false)
      expect(shell).toEqual(pane(null))
    }
    expect(s.call).toHaveBeenCalledTimes(reads)
    expect(await s.monitor.check('w1:p1')).toBeNull()
  })
  it('writes nothing while nothing changes, alive or stopped', async () => {
    const s = setup({ available: true, session: SESSION, items: [{ role: 'user', text: 'Hello', ts: null }] })
    await s.monitor.observe(pane(), false)
    expect(s.save).toHaveBeenCalledTimes(1)
    // Throttled passes, then full ones: same process, same conversation.
    for (let i = 0; i < 20; i++) { s.tick(1000); await s.monitor.observe(pane(), false) }
    expect(s.save).toHaveBeenCalledTimes(1)
    s.exit()
    await s.monitor.observe(pane(null), false)
    s.tick()
    expect(await s.monitor.observe(pane(null), false)).toBe(true)
    const writes = s.save.mock.calls.length
    for (let i = 0; i < 20; i++) { s.tick(1000); expect(await s.monitor.observe(pane(null), false)).toBe(true) }
    expect(s.save).toHaveBeenCalledTimes(writes)
    s.monitor.prune(new Set(['w1:p1']), () => true)
    expect(s.save).toHaveBeenCalledTimes(writes)
  })
  it('writes a real change at once, and the last time Codex was seen when the service stops', async () => {
    const s = setup()
    await s.monitor.observe(pane(), false)
    s.tick(1000)
    s.replace(['codex', '--profile', 'second'])
    await s.monitor.observe(pane(), false)
    expect(s.save).toHaveBeenCalledTimes(2)
    expect(s.save.mock.lastCall![0][0][1]).toMatchObject({ pid: 2002, argv: ['codex', '--profile', 'second'] })
    s.tick()
    await s.monitor.observe(pane(), false)
    expect(s.save).toHaveBeenCalledTimes(2)
    s.monitor.flush()
    expect(s.save).toHaveBeenLastCalledWith([['w1:p1', expect.objectContaining({ at: 16000 })]], true)
  })
  it('writes the last time Codex was seen at most once a minute', async () => {
    expect(AT_SAVE_MS).toBe(60000)
    const s = setup({ available: true, session: SESSION, items: [{ role: 'user', text: 'Hello', ts: null }] })
    // What the disk holds: the records as they were when written.
    let disk = '[]'
    s.save.mockImplementation((records: unknown) => { disk = JSON.stringify(records) })
    await s.monitor.observe(pane(), false)
    expect(s.save).toHaveBeenCalledTimes(1)
    const savedAt = () => JSON.parse(disk)[0][1].at as number
    // One pass a second for ten minutes, nothing changes.
    for (let i = 1; i <= 600; i++) {
      s.tick(1000)
      await s.monitor.observe(pane(), false)
      if (i === 59) expect(s.save).toHaveBeenCalledTimes(1)
      // What the disk holds is never more than a minute (and a pass) late.
      if (i >= 60) expect(s.deps.now() - savedAt()).toBeLessThanOrEqual(AT_SAVE_MS + 5000)
    }
    expect(s.save).toHaveBeenCalledTimes(11)
    // A stopped Codex has nothing new to write.
    s.exit()
    await s.monitor.observe(pane(null), false)
    s.tick()
    expect(await s.monitor.observe(pane(null), false)).toBe(true)
    const writes = s.save.mock.calls.length
    for (let i = 0; i < 180; i++) { s.tick(1000); await s.monitor.observe(pane(null), false) }
    s.monitor.prune(new Set(['w1:p1']), () => true)
    expect(s.save).toHaveBeenCalledTimes(writes)
  })
  it('detects an update that happened while the service was down after being killed', async () => {
    const s = setup()
    // Codex lives for a while; the service is killed (no flush): the disk
    // holds what the last write left.
    let disk = '[]'
    s.save.mockImplementation((records: unknown) => { disk = JSON.stringify(records) })
    for (let i = 0; i < 170; i++) { await s.monitor.observe(pane(), false); s.tick(1000) }
    const onDisk = JSON.parse(disk)
    expect(s.deps.now() - onDisk[0][1].at).toBeGreaterThan(15000)
    // Codex updates itself and stops during the short outage.
    s.exit()
    s.tick(8000)
    const restarted = createSelfUpdates(s.deps, onDisk)
    const gone = pane(null)
    expect(await restarted.observe(gone, false)).toBe(false)
    expect(gone.leaving).toBe(true)
    s.tick(3000)
    const stopped = pane(null)
    expect(await restarted.observe(stopped, false)).toBe(true)
    expect(stopped.stopped).toEqual({ reason: 'update' })
  })
  it('keeps the short limit for an outage of Herdr while the service runs', async () => {
    const s = setup()
    await s.monitor.observe(pane(), false)
    // No pass for 20 s (Herdr unreachable), then a shell: not an observed exit.
    s.tick(20000)
    s.exit()
    await s.monitor.observe(pane(null), false)
    s.tick()
    expect(await s.monitor.observe(pane(null), false)).toBe(false)
  })
})
