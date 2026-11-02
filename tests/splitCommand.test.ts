import { describe, expect, it, vi } from 'vitest'
vi.mock('../server/utils/splitShell', async importOriginal => ({ ...await importOriginal<object>(), prepareSplitShell: async () => ({}) }))

import { runSplitCommand } from '../server/utils/splitCommand'

function setup(mode: 'free' | 'busy' | 'missing', options: { race?: boolean, unknown?: boolean } = {}) {
  let reads = 0
  const agent = { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'claude', cwd: '/project' }
  const shell = { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', agent: null, agent_status: 'unknown', tokens: { wherdr_split_terminal: '1', wherdr_split_prompt: '10' } }
  const call = vi.fn(async (_machine: string, method: string, params: Record<string, unknown>) => {
    if (method === 'session.snapshot') return { panes: [agent, ...(mode === 'missing' ? [] : [shell])] }
    if (method === 'pane.split') return { pane: { ...shell, pane_id: 'w1:p3' } }
    if (method === 'pane.get') return { pane: shell }
    if (method === 'pane.process_info') {
      const busy = params.pane_id === 'w1:p2' && (mode === 'busy' || (options.race && ++reads > 1))
      return { process_info: options.unknown ? {} : { shell_pid: 10, foreground_process_group_id: busy ? 20 : 10, foreground_processes: [{ pid: busy ? 20 : 10 }] } }
    }
    return {}
  })
  return call
}

describe('run command in a wherdr-managed split shell', () => {
  it.each(['free', 'busy', 'missing'] as const)('%s shell: executes only in a verified free pane on the agent machine', async mode => {
    const call = setup(mode)
    const r = await runSplitCommand('ab12~w1:p1', '! gcloud auth login', call)
    const target = mode === 'free' ? 'w1:p2' : 'w1:p3'
    expect(r).toEqual({ ok: true, pane_id: `ab12~${target}`, created: mode !== 'free' })
    expect(call.mock.calls.every(c => c[0] === 'ab12')).toBe(true)
    expect(call.mock.calls.filter(c => c[1] === 'pane.send_input').map(c => c[2])).toEqual([
      { pane_id: target, keys: ['ctrl+e', 'ctrl+u'] },
      { pane_id: target, text: 'gcloud auth login', keys: ['enter'] },
    ])
    // The first terminal opens right of the agent; another one goes under the busy one.
    if (mode === 'missing') expect(call).toHaveBeenCalledWith('ab12', 'pane.split', { target_pane_id: 'w1:p1', direction: 'right', cwd: '/project', focus: false, env: {} })
    if (mode === 'busy') expect(call).toHaveBeenCalledWith('ab12', 'pane.split', { target_pane_id: 'w1:p2', direction: 'down', cwd: '/project', focus: false, env: {} })
    if (mode === 'free') expect(call.mock.calls.some(c => c[1] === 'pane.split')).toBe(false)
    if (mode !== 'free') expect(call).toHaveBeenCalledWith('ab12', 'pane.report_metadata', { pane_id: target, source: 'wherdr-split', tokens: { wherdr_split_terminal: '1' } })
    expect(call).toHaveBeenCalledWith('ab12', 'pane.focus', { pane_id: target })
    expect(call).toHaveBeenCalledWith('ab12', 'pane.report_metadata', { pane_id: target, source: 'wherdr-split', tokens: { wherdr_split_prompt: null } })
  })

  // A shell the user opened has no prompt hooks: it is free when the shell is
  // alone in the foreground, and busy as soon as a child process runs.
  function userShell(busy: boolean) {
    const base = setup(busy ? 'busy' : 'free')
    return vi.fn(async (machine: string, method: string, params: Record<string, unknown>) => {
      const r = await base(machine, method, params)
      if (method === 'pane.get' && params.pane_id === 'w1:p2') return { pane: { ...r.pane, tokens: {} } }
      return r
    })
  }

  it('reuses a free shell the user opened next to the agent', async () => {
    const call = userShell(false)
    const result = await runSplitCommand('w1:p1', 'echo SPLIT_COMMAND', call)
    expect(result).toEqual({ ok: true, pane_id: 'w1:p2', created: false })
    expect(call.mock.calls.some(c => c[1] === 'pane.split')).toBe(false)
    expect(call.mock.calls.filter(c => c[1] === 'pane.send_input').map(c => c[2])).toEqual([
      { pane_id: 'w1:p2', keys: ['ctrl+e', 'ctrl+u'] },
      { pane_id: 'w1:p2', text: 'echo SPLIT_COMMAND', keys: ['enter'] },
    ])
  })

  it('never types into a busy shell the user opened', async () => {
    const call = userShell(true)
    expect((await runSplitCommand('w1:p1', 'pwd', call)).pane_id).toBe('w1:p3')
    expect(call.mock.calls.filter(c => c[1] === 'pane.send_input').every(c => c[2].pane_id === 'w1:p3')).toBe(true)
  })

  it('does not trust a managed split whose prompt hooks say it is busy', async () => {
    const base = setup('free')
    const call = vi.fn(async (machine: string, method: string, params: Record<string, unknown>) => {
      const r = await base(machine, method, params)
      // A waiting builtin (`read`): shell alone in the foreground, prompt token cleared.
      if (method === 'pane.get' && params.pane_id === 'w1:p2') return { pane: { ...r.pane, tokens: { wherdr_split_terminal: '1' } } }
      return r
    })
    expect((await runSplitCommand('w1:p1', 'pwd', call)).pane_id).toBe('w1:p3')
    expect(call.mock.calls.filter(c => c[1] === 'pane.send_input').every(c => c[2].pane_id === 'w1:p3')).toBe(true)
  })

  it('prefers a managed split over a shell the user opened', async () => {
    const managed = { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t1', agent: null, tokens: { wherdr_split_terminal: '1', wherdr_split_prompt: '10' } }
    const base = userShell(false)
    const call = vi.fn(async (machine: string, method: string, params: Record<string, unknown>) => {
      if (method === 'session.snapshot') {
        const r = await base(machine, method, params)
        return { panes: [...r.panes, managed] }
      }
      if (method === 'pane.get' && params.pane_id === 'w1:p4') return { pane: managed }
      return base(machine, method, params)
    })
    expect((await runSplitCommand('w1:p1', 'pwd', call)).pane_id).toBe('w1:p4')
  })

  it('falls back to a plain shell check when a new shell never reports its prompt', async () => {
    vi.useFakeTimers()
    try {
      const tokens: Record<string, string | null> = {}
      const base = setup('missing')
      const call = vi.fn(async (machine: string, method: string, params: Record<string, any>) => {
        if (method === 'pane.report_metadata') Object.assign(tokens, params.tokens)
        if (method === 'pane.get') return { pane: { pane_id: 'w1:p3', tab_id: 'w1:t1', agent: null, tokens: { ...tokens } } }
        return base(machine, method, params)
      })
      const run = runSplitCommand('w1:p1', 'pwd', call)
      await vi.runAllTimersAsync()
      expect((await run).pane_id).toBe('w1:p3')
      // Untagged, so the next click reuses it like a shell the user opened.
      expect(call).toHaveBeenCalledWith(expect.anything(), 'pane.report_metadata', { pane_id: 'w1:p3', source: 'wherdr-split', tokens: { wherdr_split_terminal: null } })
      expect(call.mock.calls.filter(c => c[1] === 'pane.send_input').at(-1)![2]).toEqual({ pane_id: 'w1:p3', text: 'pwd', keys: ['enter'] })
    } finally { vi.useRealTimers() }
  })

  it('opens a new split if the managed shell becomes busy before sending', async () => {
    const call = setup('free', { race: true })
    expect((await runSplitCommand('w1:p1', 'pwd', call)).pane_id).toBe('w1:p3')
    expect(call.mock.calls.filter(c => c[1] === 'pane.send_input').map(c => c[2].pane_id)).toEqual(['w1:p3', 'w1:p3'])
  })

  it('serializes simultaneous requests that share the same shell', async () => {
    const base = setup('free')
    let sent = false
    const call = vi.fn(async (machine: string, method: string, params: Record<string, unknown>) => {
      if (method === 'pane.send_input') sent = true
      if (method === 'pane.process_info' && params.pane_id === 'w1:p2' && sent) {
        return { process_info: { shell_pid: 10, foreground_process_group_id: 20, foreground_processes: [{ pid: 20 }] } }
      }
      return base(machine, method, params)
    })
    const results = await Promise.all([runSplitCommand('w1:p1', 'sleep 10', call), runSplitCommand('w1:p1', 'pwd', call)])
    expect(results.map(r => r.pane_id)).toEqual(['w1:p2', 'w1:p3'])
  })

  it('fails closed when process readiness is unavailable', async () => {
    vi.useFakeTimers()
    try {
      const call = setup('missing', { unknown: true })
      const run = expect(runSplitCommand('w1:p1', 'pwd', call)).rejects.toMatchObject({ code: 'busy_pane' })
      await vi.runAllTimersAsync()
      await run
      expect(call.mock.calls.some(c => c[1] === 'pane.send_input')).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it.each(['', 'pwd\nrm file', '\u001b[A'])('rejects invalid command %j before any RPC', async command => {
    const call = setup('free')
    await expect(runSplitCommand('w1:p1', command, call)).rejects.toMatchObject({ code: 'bad_command' })
    expect(call).not.toHaveBeenCalled()
  })
})
