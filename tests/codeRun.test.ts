// Commands run with Run: a live card from the click until the transcript
// writes the command, then that entry alone (composables/useCodeRun.ts).
import { describe, expect, it } from 'vitest'
import { RUN_MAX_MS, holdRuns, runMarks, settleRuns, type CodeRun } from '../app/composables/useCodeRun'

const at = Date.parse('2026-01-01T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const entry = (text: string, t: number, ms?: number) => ({ role: 'bash' as const, text, ts: iso(t), out: 'ok', ...(ms === undefined ? {} : { ms }) })
const old = entry('make deploy', at - 3_600_000)

describe('runs of a command', () => {
  it('finishes with its own entry, once written with its output, at its end', () => {
    const run: CodeRun = { cmd: 'make deploy', at }
    // Only an older entry, or this one without its output yet: still running.
    expect(settleRuns([run], [old, { role: 'bash', text: 'make deploy', ts: iso(at + 1000) }], at + 5000)[0]!.doneAt).toBeUndefined()
    const done = settleRuns([run], [old, entry('make  deploy', at + 1000, 60_000)], at + 90_000)[0]!
    expect(done.doneAt).toBe(at + 61_000)
    expect(runMarks([done])).toEqual({ makedeploy: { running: false, at: at + 61_000 } })
  })

  it('is not finished by an older entry loaded above, nor missed when the list restarts shorter', () => {
    const run: CodeRun = { cmd: 'make deploy', at }
    expect(settleRuns([run], [old], at + 5000)[0]!.doneAt).toBeUndefined()
    expect(settleRuns([run], [entry('make deploy', at + 60_000)], at + 61_000)[0]!.doneAt).toBe(at + 60_000)
  })

  it('two runs of one command take one entry each, in order', () => {
    const runs: CodeRun[] = [{ cmd: 'npm test', at }, { cmd: 'npm test', at: at + 1000 }]
    const one = settleRuns(runs, [entry('npm test', at + 30_000)], at + 31_000)
    expect(one.map(r => r.doneAt !== undefined)).toEqual([true, false])
    expect(runMarks(one).npmtest!.running).toBe(true)
    const both = settleRuns(one, [entry('npm test', at + 30_000), entry('npm test', at + 40_000)], at + 41_000)
    expect(both.map(r => r.doneAt)).toEqual([at + 30_000, at + 40_000])
  })

  it('stops showing as running once past the limit', () => {
    expect(settleRuns([{ cmd: 'sleep 1', at }], [], at + RUN_MAX_MS + 1)[0]!.doneAt).toBe(at + RUN_MAX_MS + 1)
  })

  it('run while idle: never held, its card shows from the click', () => {
    const run: CodeRun = { cmd: 'echo hi', at }
    expect(holdRuns([run], [], at + 1000)[0]).toBe(run)
  })

  it('run while Claude works: held in its queue, one card from when Claude takes it, one entry', () => {
    const runs: CodeRun[] = [{ cmd: 'echo hi', at }]
    // Claude's transcript queues "! echo hi" as "echo hi"; one queued entry holds the latest run only.
    const held = holdRuns(runs, ['echo hi'], at + 5000)
    expect(held[0]).toMatchObject({ held: true, at })
    expect(holdRuns(held, ['echo hi'], at + 9000)[0]).toBe(held[0])
    expect(settleRuns(held, [], at + RUN_MAX_MS + 1)[0]!.doneAt).toBeUndefined()
    const started = holdRuns(held, [], at + 40_000)[0]!
    expect(started).toMatchObject({ held: false, at, startedAt: at + 40_000 })
    expect(settleRuns([started], [entry('echo hi', at + 40_500)], at + 41_000)[0]!.doneAt).toBe(at + 40_500)
    // Seen late (phone locked at the turn's end): the queue empties as the entry lands, which settles it.
    const late = at + 300_000
    expect(settleRuns(holdRuns(held, [], late), [entry('echo hi', at + 40_000, 100)], late)[0]!.doneAt).toBe(at + 40_100)
    const two: CodeRun[] = [{ cmd: 'echo hi', at }, { cmd: 'echo hi', at: at + 1 }]
    expect(holdRuns(two, ['! echo hi'], at + 2).map(r => Boolean(r.held))).toEqual([false, true])
  })
})
