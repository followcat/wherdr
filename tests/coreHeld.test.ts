import { describe, expect, it } from 'vitest'
import { createHeld } from '../server/utils/coreHeld'
import { codexLine } from '../shared/codexLaunch'
import { addSending, prune, returnHeld, settle } from '../app/utils/outbox'
import type { Pane } from '../shared/types'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pane = (extra: Partial<Pane> = {}) => ({ id: 'p1', coreAddress: 't1', agent: 'codex', status: 'idle', installing: true, title: null, cwd: '/w', agentSession: null, ...extra }) as Pane

describe('a message sent while Codex installs or updates itself', () => {
  it('waits, listed as held, then is typed once Codex is ready, one at a time', async () => {
    const sent: string[] = []
    const held = createHeld(async (_p, q) => { sent.push(q.text) }, () => 5)
    expect(held.hold(pane(), 'Hi', 'w-abc')).toEqual({ id: 'w-abc', text: 'Hi', at: 5, state: 'held' })
    held.hold(pane(), 'Next')
    const installing = [pane()]
    held.apply(installing)
    expect(sent).toEqual([])
    expect(installing[0]!.queued?.map(q => q.text)).toEqual(['Hi', 'Next'])
    const ready = [pane({ installing: undefined })]
    held.apply(ready)
    expect(sent).toEqual(['Hi'])
    // Listed until it was typed, then the next one goes.
    expect(ready[0]!.queued?.map(q => q.text)).toEqual(['Hi', 'Next'])
    await new Promise(r => setTimeout(r, 0))
    const after = [pane({ installing: undefined })]
    held.apply(after)
    expect(sent).toEqual(['Hi', 'Next'])
    expect(after[0]!.queued?.map(q => q.text)).toEqual(['Next'])
  })
  it('is dropped when Codex exits or is stopped by its update, and comes back into the field', () => {
    const sent: string[] = []
    const held = createHeld(async (_p, q) => { sent.push(q.text) })
    const q = held.hold(pane(), 'Hi', 'w-abc')
    const stopped = [pane({ installing: undefined, stopped: { reason: 'update' }, status: 'blocked' })]
    held.apply(stopped)
    expect(stopped[0]!.queued).toBeUndefined()
    held.apply([pane({ installing: undefined })])
    expect(sent).toEqual([])
    // The sending device: its copy stays while the server lists it, then comes back as text.
    const local = prune(settle(addSending([], 'w-abc', 'Hi', 1), 'w-abc', q, 2), [q], 3)
    expect(local.map(x => x.state)).toEqual(['held'])
    expect(returnHeld(local, []).back).toEqual(['Hi'])
    // Typed while Codex stayed: no longer held, nothing to give back.
    expect(returnHeld(prune(local, [], 4), []).back).toEqual([])
  })
  it('keeps a message whose send failed for the next try, but never types again one that may have reached Codex', async () => {
    let fail: Error & { code?: string } = Object.assign(new Error('disconnected'), { code: 'unreachable' })
    let tries = 0
    const held = createHeld(async () => { tries++; throw fail })
    held.hold(pane(), 'Hi')
    const ready = () => [pane({ installing: undefined })]
    held.apply(ready())
    await new Promise(r => setTimeout(r, 0))
    const again = ready()
    held.apply(again)
    expect(again[0]!.queued?.map(q => q.text)).toEqual(['Hi'])
    fail = Object.assign(new Error('timeout'), { code: 'timeout' })
    await new Promise(r => setTimeout(r, 0))
    held.apply(ready())
    await new Promise(r => setTimeout(r, 0))
    // Timed out: listed as 'unseen' (its device puts it back into the field), never sent again.
    const before = tries
    const after = ready()
    held.apply(after)
    expect(after[0]!.queued).toMatchObject([{ text: 'Hi', state: 'failed', reason: 'unseen' }])
    await new Promise(r => setTimeout(r, 0))
    held.apply(ready())
    expect(tries).toBe(before)
  })
  it('types a first message held behind a dialog only once its holder hands it over', async () => {
    const sent: string[] = []
    const held = createHeld(async (_p, q) => { sent.push(q.text) })
    const q = held.hold(pane(), 'Hi', undefined, true)
    const ready = () => [pane({ installing: undefined })]
    held.apply(ready())
    expect(sent).toEqual([])
    held.handOver('t1', q.id, false)
    held.apply(ready())
    expect(sent).toEqual(['Hi'])
    // Typed by its holder: gone.
    const r = held.hold(pane(), 'Other', undefined, true)
    held.handOver('t1', r.id, true)
    await new Promise(x => setTimeout(x, 0))
    const after = ready()
    held.apply(after)
    expect(after[0]!.queued).toBeUndefined()
  })
})

describe('the Codex launch line', () => {
  // A fake codex (its version changes when it "updates") and a fake hc, in a fresh folder.
  const run = (update: boolean) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-line-'))
    const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    write('codex', `if [ "$1" = --version ]; then cat "${dir}/v" 2>/dev/null || echo 0.166.0; exit 0; fi\necho "$@" > "${dir}/args"\n${update ? `echo 0.167.0 > "${dir}/v"` : ''}\nexit 3`)
    write('hc', `echo "$@" > "${dir}/label"`)
    write('sh', `echo kept > "${dir}/shell"`)
    let code = 0
    try { execFileSync('/bin/sh', ['-c', codexLine(['resume', '--last'])], { env: { PATH: `${dir}:/usr/bin:/bin`, HC_TERMINAL_ID: 't7' } }) } catch (e) { code = (e as { status: number }).status }
    const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : null)
    const out = { code, args: read('args'), label: read('label'), shell: read('shell') }
    fs.rmSync(dir, { recursive: true, force: true })
    return out
  }
  it('starts Codex with its update check off and ends with it on a plain exit', () => {
    expect(run(false)).toEqual({ code: 3, args: '-c check_for_update_on_startup=false resume --last', label: null, shell: null })
  })
  it('keeps the terminal as a shell, labelled for the restart card, when Codex exits after updating itself', () => {
    expect(run(true)).toMatchObject({ code: 0, label: 'label t7 wherdr.codex-updated=1', shell: 'kept' })
  })
})
