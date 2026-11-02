import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { splitShellHooks } from '../server/utils/splitShell'
import { runSplitCommand } from '../server/utils/splitCommand'
import { closeProcess, closeProcessMessage } from '../shared/closeProcess'
import { hasCommands } from './helpers/commands'

// A real interactive PTY, including a readline builtin (`read -e`), whose
// foreground process information is indistinguishable from the shell prompt.
const probe = String.raw`
import json, os, pty, select, subprocess, sys, time
root, hook = sys.argv[1:]
state = root + '/state'
pid, fd = pty.fork()
if pid == 0:
    os.environ.update(PROMPT_COMMAND=hook, STATE=state, HERDR_PANE_ID='w1:p2', PS1='PROMPT> ')
    os.execvp('bash', ['bash', '--noprofile', '--norc', '-i'])
def wait(text):
    output = b''
    end = time.monotonic() + 5
    while text not in output:
        if time.monotonic() > end: raise Exception(repr(output))
        if select.select([fd], [], [], .05)[0]: output += os.read(fd, 65536)
    return output.decode(errors='replace')
def sample():
    group = os.tcgetpgrp(fd)
    rows = subprocess.check_output(['ps', '-eo', 'pid=,pgid='], text=True).splitlines()
    procs = sorted(int(row.split()[0]) for row in rows if int(row.split()[1]) == group)
    return dict(pid=pid, group=group, procs=procs, token=open(state).read().strip())
try:
    wait(b'PROMPT> ')
    idle = sample()
    busy = []
    for read in ['read -r -p "Waiting for input: " response', 'read -e -r response']:
        os.write(fd, (read + '; printf "READ_RECEIVED=<%s>\\n" "$response"\n').encode())
        end = time.monotonic() + 5
        while time.monotonic() < end:
            current = sample()
            if not current['token'] and current['procs'] == [pid]: break
            time.sleep(.01)
        busy.append(sample())
        os.write(fd, b'original response\n')
        output = wait(b'PROMPT> ')
        assert 'READ_RECEIVED=<original response>' in output, output
    print(json.dumps(dict(idle=idle, busy=busy, resumed=sample())))
finally:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    os.close(fd)
`

const supported = hasCommands('bash', 'python3', 'ps') && spawnSync('bash', ['--noprofile', '--norc', '-c', '(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) ))']).status === 0

describe.skipIf(!supported)('split shell prompt attestation', () => {
  it('clears readiness before read and read -e despite identical foreground PIDs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-shell-'))
    try {
      const binary = path.join(dir, 'report')
      fs.writeFileSync(binary, '#!/bin/sh\ncase "$*" in *--clear-token*) : > "$STATE";; *--token*) printf %s "${9#*=}" > "$STATE";; esac\n', { mode: 0o700 })
      const hooks = splitShellHooks(binary, 'test')
      const sample = JSON.parse(execFileSync('python3', ['-c', probe, dir, hooks.bash], { timeout: 15000, encoding: 'utf8' }))
      expect(sample.idle.token).toBe(String(sample.idle.pid))
      const info = (s: typeof sample.idle) => ({ shell_pid: s.pid, foreground_process_group_id: s.group, foreground_processes: s.procs.map((pid: number) => ({ pid })) })
      expect(closeProcess(info(sample.idle), sample.idle.token)).toEqual({ state: 'idle' })
      expect(sample.resumed.token).toBe(String(sample.idle.pid))
      for (const busy of sample.busy) {
        expect(busy.group).toBe(busy.pid)
        expect(busy.procs).toEqual([busy.pid])
        expect(busy.token).toBe('')
        const state = closeProcess(info(busy), busy.token)
        expect(state).toEqual({ state: 'unknown' })
        expect(closeProcessMessage({ agent: null }, state, en => en)).toBe('Anything running in it will be stopped.')
        const call = vi.fn(async (_machine: string, method: string, params: Record<string, unknown>) => {
          const pane = { pane_id: 'w1:p2', tab_id: 'w1:t1', agent: null, agent_status: 'unknown', tokens: { wherdr_split_terminal: '1', wherdr_split_prompt: busy.token } }
          if (method === 'session.snapshot') return { panes: [{ ...pane, pane_id: 'w1:p1', agent: 'claude', cwd: '/project' }, pane] }
          if (method === 'pane.get') return { pane }
          if (method === 'pane.process_info') return { process_info: { shell_pid: busy.pid, foreground_process_group_id: busy.group, foreground_processes: busy.procs.map((pid: number) => ({ pid })) } }
          if (method === 'pane.split') throw new Error('new terminal requested')
          return params
        })
        await expect(runSplitCommand('w1:p1', 'echo SPLIT_COMMAND', call, async () => ({}))).rejects.toThrow('new terminal requested')
        expect(call.mock.calls.some(c => c[1] === 'pane.send_input')).toBe(false)
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
