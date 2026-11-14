import { describe, expect, it } from 'vitest'
import { incidentReasons, toTell } from '../shared/pm/incidentWake'
import { interrupted } from '../shared/pm/recovery'
import { enqueue, wakeHead } from '../shared/pm/wakes'
import type { Incident } from '../shared/pm/incident'
import { initialState } from '../shared/pm/steps'
import type { Task } from '../shared/pm/run'

const NOW = Date.parse('2026-01-10T12:00:00Z')
const task = (id: string, more: Partial<Task> = {}): Task => ({ id, project: id.split('-')[0]!, title: id, description: '', type: 'simple', state: 'working', run: `r-${id}`, step: { ...initialState(), started: true, since: 1 }, createdAt: Number(id.split('-')[1]), ...more })
const incident = (more: Partial<Incident> = {}): Incident => ({
  id: 'i1', at: NOW, machine: 'b', label: 'host-b', cause: 'restart', evidence: ['CO-1 worker: terminal not found, like every other agent\'s on host-b'],
  tasks: ['CO-1', 'CO-2', 'CO-3', 'CO-4', 'WEB-1'], runs: ['r-CO-1', 'r-CO-2', 'r-CO-3', 'r-CO-4', 'r-WEB-1'], ...more,
})

describe('the Incident wake', () => {
  it('says the cause and its evidence, what was resumed, what waits and why, what needs the user', () => {
    const i = incident()
    const waits = (t: Task) => interrupted(t, i, NOW).task
    const tasks = [
      { ...task('CO-1'), run: 'r-CO-1+' }, // resumed: a new run
      waits(task('CO-2', { after: 'CO-3' })),
      { ...waits(task('CO-3')), held: 'no room on host-b' },
      { ...task('CO-4'), run: 'r-CO-4+', state: 'waiting' as const, waitKind: 'permission' as const },
      { ...task('WEB-1'), run: 'r-WEB-1+' },
    ]
    const text = incidentReasons(i, tasks, 'CO').join('\n')
    expect(text).toMatch(/^Incident i1 on host-b at 2026-01-10T12:00:00.000Z: herdr-core or wherdr restarted .*Evidence \(read by the engine\): CO-1 worker: terminal not found/)
    expect(text).toMatch(/^Resumed: CO-1\.$/m)
    expect(text).toMatch(/^Still waits \(the engine resumes it by itself\): CO-2 \(waits for CO-3 to resume first\); CO-3 \(no room on host-b\)\.$/m)
    expect(text).toMatch(/^Needs the user: CO-4 \(a permission request\)\.$/m)
    expect(text).toMatch(/never another: Never state a cause you did not read/)
    // Its own project only; Alfred gets every project's.
    expect(text).not.toMatch(/WEB-1/)
    expect(incidentReasons(i, tasks).join('\n')).toMatch(/^Resumed: CO-1, WEB-1\.$/m)
  })

  it('a machine still offline, an account limit until its reset, a stop again right after a resume', () => {
    const off = incident({ cause: 'offline', tasks: ['CO-1'], evidence: ['herdr-core on host-b does not answer: offline'] })
    expect(incidentReasons(off, [interrupted(task('CO-1'), off, NOW).task]).join('\n')).toMatch(/Resumed: none\.\nStill waits .*: CO-1 \(host-b still offline\)\./)
    const lim = incident({ cause: 'limit', tasks: ['CO-1'], evidence: ['CO-1 worker: ended at 2026-01-10T11:59:00.000Z; the account\'s reading at 2026-01-10T11:58:00.000Z says it hit its limit, it resets at 2026-01-10T15:00:00.000Z'] })
    expect(incidentReasons(lim, [interrupted(task('CO-1'), lim, NOW).task]).join('\n')).toMatch(/CO-1 \(the account's limit until 2026-01-10T15:00:00\.000Z\)/)
    const killed = incident({ cause: 'killed', tasks: ['CO-1'] })
    const again = interrupted({ ...task('CO-1'), recovery: { incident: 'i0', cause: 'killed', machine: 'b', label: 'host-b', at: NOW - 120_000, n: 1, resumedAt: NOW - 60_000 } }, killed, NOW).task
    expect(incidentReasons(killed, [again]).join('\n')).toMatch(/Needs you: CO-1 \(stopped again right after the engine resumed it/)
  })

  it('one wake per incident: told once its resumes settle, never again', () => {
    const a = incident(), b = incident({ id: 'i2', machine: 'c', label: 'host-c', cause: 'offline' })
    // A resume still under way (busy) waits; told, or too old (before an update): never.
    expect(toTell([a, b], new Set(['i1']), NOW).map(i => i.id)).toEqual(['i2'])
    expect(toTell([{ ...a, told: NOW }], new Set(), NOW + 60_000)).toEqual([])
    expect(toTell([a], new Set(), NOW + 2 * 3_600_000)).toEqual([])
    // Each incident its own wake; the same one never doubles in the queue.
    const w1 = enqueue([], 'CO', ['first'], NOW, 'w1', false, { kind: 'incident', about: 'i1' })
    expect(enqueue([w1], 'CO', ['first'], NOW, 'w2', false, { kind: 'incident', about: 'i1' })).toMatchObject({ id: 'w1', reasons: ['first'] })
    expect(enqueue([w1], 'CO', ['other'], NOW, 'w2', false, { kind: 'incident', about: 'i2' }).id).toBe('w2')
    expect(wakeHead(w1)).toBe('Incident: i1, wake w1')
  })
})
