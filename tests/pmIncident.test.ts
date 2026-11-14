import { describe, expect, it } from 'vitest'
import { diagnose, isOpen, limitText, type GoneAgent, type MachineFacts } from '../shared/pm/incident'
import { parseCommand } from '../shared/pm/coordinator'

const NOW = Date.parse('2026-01-10T12:00:00Z')
const agent = (id: string, over: Partial<GoneAgent['run']> = {}, terminal?: GoneAgent['terminal']): GoneAgent =>
  ({ run: { id, task: `WEB-${id}`, role: 'worker', program: 'claude', machine: '', startedAt: NOW - 3_600_000, ...over }, ...(terminal ? { terminal } : {}) })
const host: MachineFacts = { key: '', label: 'host-a', state: 'connected', coreStartedAt: NOW - 7_200_000 }
const remote: MachineFacts = { key: 'b', label: 'host-b', state: 'connected', live: 0 }
const noLimit = () => null
const causes = (gone: GoneAgent[], machines = [host, remote], limit = noLimit) => diagnose(gone, machines, limit, NOW).map(i => [i.machine, i.cause, i.tasks])

describe('diagnose: why agents are gone', () => {
  it('machine offline: its herdr-core does not answer', () => {
    const [i] = diagnose([agent('1', { machine: 'b' }), agent('2', { machine: 'b' })], [host, { ...remote, state: 'unreachable', since: NOW - 60_000, why: 'ssh timeout' }], noLimit, NOW)
    expect(i).toMatchObject({ cause: 'offline', label: 'host-b', tasks: ['WEB-1', 'WEB-2'], runs: ['1', '2'] })
    expect(i!.evidence[0]).toMatch(/unreachable since .*ssh timeout/)
  })

  it('restart: core started after the runs, or every terminal of a machine gone at once, or a restart reason', () => {
    expect(causes([agent('1')], [{ ...host, coreStartedAt: NOW - 60_000 }])).toEqual([['', 'restart', ['WEB-1']]])
    expect(causes([agent('1', { machine: 'b' }), agent('2', { machine: 'b' })])).toEqual([['b', 'restart', ['WEB-1', 'WEB-2']]])
    expect(causes([agent('1', {}, { state: 'finished', reason: 'host_shutdown', exit_code: null })])).toEqual([['', 'restart', ['WEB-1']]])
  })

  it('two agents lost while others still run on the machine, or nothing known of the others: no restart', () => {
    const two = [agent('1', { machine: 'b' }), agent('2', { machine: 'b' })]
    expect(causes(two, [host, { ...remote, live: 1 }])).toEqual([['b', 'unknown', ['WEB-1', 'WEB-2']]])
    expect(causes(two, [host, { ...remote, live: undefined }])).toEqual([['b', 'unknown', ['WEB-1', 'WEB-2']]])
  })

  it('killed or crashed: an exit code or a signal; out of memory only when its output says so', () => {
    expect(causes([agent('1', {}, { state: 'finished', reason: 'exited', exit_code: 1 })])).toEqual([['', 'killed', ['WEB-1']]])
    expect(causes([agent('1', {}, { state: 'finished', reason: 'killed', signal: 9 })])).toEqual([['', 'killed', ['WEB-1']]])
    expect(causes([agent('1', {}, { state: 'finished', exit_code: 134, lastLines: 'FATAL ERROR: JavaScript heap out of memory' })])).toEqual([['', 'out-of-memory', ['WEB-1']]])
  })

  it('account limit only when the account\'s reading at that time says so', () => {
    const q = { at: NOW, five: { used: 100, resetsAt: NOW + 3_600_000 }, week: null }
    const limit = (_p: string, _m: string, at: number) => limitText(q, at)
    expect(causes([agent('1', {}, { state: 'finished', exit_code: 1, finished_ms: NOW })], [host], limit)).toEqual([['', 'limit', ['WEB-1']]])
    // A reading from hours before does not decide: the crash stays a crash.
    expect(causes([agent('1', {}, { state: 'finished', exit_code: 1, finished_ms: NOW + 5 * 3_600_000 })], [host], limit)).toEqual([['', 'killed', ['WEB-1']]])
    expect(limitText({ ...q, five: { used: 80, resetsAt: null } }, NOW)).toBeNull()
  })

  it('unknown when the facts do not decide: one terminal missing on a core older than it, an exit 0', () => {
    expect(causes([agent('1')])).toEqual([['', 'unknown', ['WEB-1']]])
    expect(causes([agent('1', {}, { state: 'finished', reason: 'exited', exit_code: 0 })])).toEqual([['', 'unknown', ['WEB-1']]])
  })

  it('one incident per machine and cause; open until a task it hit runs again', () => {
    const list = diagnose([agent('1', {}, { state: 'finished', exit_code: 2 }), agent('2'), agent('3', { machine: 'b' })], [host, { ...remote, state: 'needs_login' }], noLimit, NOW)
    expect(list.map(i => i.cause)).toEqual(['killed', 'unknown', 'offline'])
    const i = { ...list[0]!, id: 'x' }
    expect(isOpen(i, [{ id: 'WEB-1', state: 'waiting', run: '1' }])).toBe(true)
    // Started again (a new run), then waiting for a merge: closed.
    expect(isOpen(i, [{ id: 'WEB-1', state: 'waiting', run: '9' }])).toBe(false)
  })

  it('wherdr pm incidents [--since]', () => {
    expect(parseCommand(['incidents'])).toEqual({ name: 'incidents' })
    expect(parseCommand(['incidents', '--since', '2026-01-01'])).toEqual({ name: 'incidents', since: Date.parse('2026-01-01') })
    expect(parseCommand(['incidents', '--since', 'yesterday'])).toMatchObject({ error: expect.stringContaining('--since') })
  })
})
