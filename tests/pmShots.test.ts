import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addShot, isImage, shotRows, shotsMissing, type Shot } from '../shared/pm/shots'
import { initialState, onEvent, planSteps, type StepState } from '../shared/pm/steps'
import { validateTemplate, type Template } from '../shared/pm/workflow'
import { createPmStore } from '../server/utils/pmStore'
import { uploadShot, userSendBack, userShot } from '../server/utils/pmBoard'

// A visual task: the worker gives before and after screenshots, then the user merges.
const visual = (screenshots?: 'after' | 'before-after'): Template => ({
  id: 'visual',
  prefs: { agent: 'claude', model: 'm' },
  taskTypes: {
    ui: {
      steps: [
        { id: 'todo' },
        { id: 'work', holder: 'worker', ends: 'report', evidence: ['link', 'screenshots'], ...(screenshots ? { screenshots } : {}) },
        { id: 'merge', ends: 'user', userLabel: 'Merged' },
        { id: 'done' },
      ],
    },
  },
})
const shot = (phase: Shot['phase'], n = 1): Shot => ({ file: `${String(n).padStart(12, '0')}.png`, phase, at: n })
const working = (): StepState => ({ ...initialState(), started: true, at: 1 })
const report = { kind: 'report', from: 'worker', evidence: { link: 'https://git.example/pr/1' } } as const

describe('screenshots evidence', () => {
  it('is set on a step with a before/after option, checked by the template', () => {
    expect(validateTemplate(visual())).toEqual([])
    expect(validateTemplate(visual('before-after'))).toEqual([])
    const bad = visual('before-after')
    const work = bad.taskTypes.ui!.steps[1] as { evidence?: string[], screenshots?: string }
    work.screenshots = 'during'
    expect(validateTemplate(bad)).toEqual([{ path: 'taskTypes.ui.steps[1].screenshots', message: 'must be one of after, before-after' }])
    work.screenshots = 'after'
    work.evidence = ['link']
    expect(validateTemplate(bad)).toEqual([{ path: 'taskTypes.ui.steps[1].screenshots', message: 'only for a step whose evidence has screenshots' }])
  })

  it('tells the agent what to give and how to upload it', () => {
    expect(planSteps(visual('before-after'), { type: 'ui' })[1]!.text).toContain('give a link, screenshots before and after the change.')
    expect(planSteps(visual(), { type: 'ui' })[1]!.text).toContain('the command under "Screenshots" in your instructions file.')
  })

  it('a step that requires screenshots does not pass without them', () => {
    const plan = planSteps(visual('before-after'), { type: 'ui' })
    const none = onEvent(plan, working(), report, 0)
    expect(none.refused).toBe('Not done yet: step "work" needs screenshots before and after the change.')
    expect(none.state.at).toBe(1)
    const afterOnly = onEvent(plan, { ...working(), shots: { work: [shot('after')] } }, report, 0)
    expect(afterOnly.refused).toBe('Not done yet: step "work" needs screenshots before.')
    const both = onEvent(plan, { ...working(), shots: { work: [shot('before'), shot('after', 2)] } }, report, 0)
    expect(both.refused).toBeUndefined()
    expect(both.state.at).toBe(2)
    // After only: one screenshot of the result is enough.
    expect(shotsMissing(plan[1]!, [shot('after')])).toEqual(['before'])
    expect(shotsMissing(planSteps(visual(), { type: 'ui' })[1]!, [shot('after')])).toEqual([])
    expect(shotsMissing({ evidence: ['link'] })).toEqual([])
  })

  it('takes a screenshot only for an open step that asks for one of that phase', () => {
    const plan = planSteps(visual(), { type: 'ui' })
    expect(addShot(plan, initialState(), shot('after'))).toEqual({ refused: 'The task has no open step' })
    expect(addShot(plan, working(), shot('before'))).toEqual({ refused: 'Step "work" asks for screenshots of the result only' })
    expect(addShot(plan, { ...working(), at: 2 }, shot('after'))).toEqual({ refused: 'Step "merge" asks for no screenshots' })
    const ok = addShot(plan, working(), shot('after'))
    expect(ok).toEqual({ state: { ...working(), shots: { work: [shot('after')] } } })
    const full = { ...working(), shots: { work: Array.from({ length: 24 }, (_, i) => shot('after', i)) } }
    expect(addShot(plan, full, shot('after'))).toEqual({ refused: 'Step "work" has 24 screenshots already' })
  })

  it('knows a PNG, a JPEG and a WebP by their first bytes', () => {
    const webp = Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')
    expect([isImage(webp, 'webp'), isImage(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), 'jpg'), isImage(webp, 'png'), isImage(Buffer.alloc(0), 'png')]).toEqual([true, true, false, false])
  })

  it('pairs before and after for the gallery, in upload order', () => {
    const list = [shot('before', 1), shot('after', 2), shot('before', 3)]
    expect(shotRows(list, 'before-after')).toEqual([{ before: list[0], after: list[1] }, { before: list[2] }])
    expect(shotRows(list, 'after')).toEqual([{ after: list[1] }])
  })
})

describe('screenshot upload', () => {
  let dir = ''
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('keeps the image with the task\'s data and records it on the step', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-shots-'))
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(visual())
    await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'UI', name: 'UI', machine: '', path: '/src/ui', template: 'visual', addedAt: 1 }] }))
    const task = await store.addTask({ project: 'UI', title: 'New look', type: 'ui' })
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])
    const key = 'k'.repeat(32)
    const up = (phase: string, body = png, ctype = 'image/png', token: unknown = key) => uploadShot(store, task.id, phase, body, ctype, token)
    // No key on the task yet (never started), a wrong key, no key: the same refusal.
    await expect(up('after')).rejects.toMatchObject({ code: 'forbidden' })
    await store.saveTask({ ...task, state: 'working', step: working(), shotToken: key })
    await expect(up('after', png, 'image/png', 'x'.repeat(32))).rejects.toMatchObject({ code: 'forbidden' })
    await expect(up('after', png, 'image/png', null)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(up('after', png, 'image/gif')).rejects.toMatchObject({ code: 'bad_input' })
    // Any bytes sent as a PNG are not an image.
    await expect(up('after', Buffer.from('not an image at all'))).rejects.toMatchObject({ code: 'bad_input' })
    await expect(up('after', png, 'image/jpeg')).rejects.toMatchObject({ code: 'bad_input' })
    await expect(up('before')).rejects.toMatchObject({ code: 'refused' })
    const [a, b] = await Promise.all([up('after'), up('after')])
    // Both kept, even sent at once (in either order); only these two files are on disk.
    expect((await store.task(task.id))?.step?.shots?.work?.map(s => s.file).sort()).toEqual([a!.file, b!.file].sort())
    expect((await fs.readdir(path.join(dir, 'shots', task.id))).sort()).toEqual([a!.file, b!.file].sort())
    expect(await store.shot(task.id, a!.file)).toEqual(png)
    expect(await store.shot(task.id, '../tasks/UI-1.json')).toBeNull()
  })

  it('after new commits since the review, replaces the worker\'s screenshots at the merge step', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-shots-'))
    const store = createPmStore(dir)
    await store.setEnabled(true)
    const t = visual()
    t.taskTypes.ui!.steps.splice(2, 0, { id: 'review', holder: 'reviewer', ends: 'verdict', sendBack: 'work' })
    await store.saveTemplate(t)
    await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'UI', name: 'UI', machine: '', path: '/src/ui', template: 'visual', addedAt: 1 }] }))
    const task = await store.addTask({ project: 'UI', title: 'New look', type: 'ui' })
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])
    const key = 'k'.repeat(32), reviewed = 'a'.repeat(40), reworked = 'b'.repeat(40)
    const old = shot('after', 1)
    await store.saveTask({ ...task, state: 'working', shotToken: key, step: { ...working(), at: 3, proofs: { review: { commit: reviewed } }, shots: { work: [old] } } })
    const up = (head: string) => uploadShot(store, task.id, 'after', png, 'image/png', key, async () => head)
    // The head is the reviewed commit: the merge step takes no screenshots.
    await expect(up(reviewed)).rejects.toMatchObject({ code: 'refused', message: 'Step "merge" asks for no screenshots' })
    // New commits: the first shot replaces the shown set, the next ones join it.
    const a = await up(reworked), b = await up(reworked)
    expect(a.rework).toBe(reviewed)
    const step = (await store.task(task.id))!.step!
    expect(step.at).toBe(3)
    expect(step.shots?.work?.map(s => s.file)).toEqual([a.file, b.file])
    expect(step.earlierShots).toEqual({ work: [old] })
    // An approval dropped: the worker's new shots carry its reason for the banner, even at the reviewed commit (WHR-333).
    await store.saveTask({ ...(await store.task(task.id))!, step: { ...step, lookAgain: { why: 'the interface changed', at: 5, since: reviewed } } })
    await uploadShot(store, task.id, 'after', png, 'image/png', key, async () => reviewed, 'Back to review because: the merge with  UI-9 moved the button')
    const told = (await store.task(task.id))!
    expect(told.step!.lookAgain).toEqual({ why: 'the interface changed', at: 5, since: reviewed, reason: 'the merge with UI-9 moved the button' })
    expect(told.log?.at(-1)).toMatchObject({ by: 'worker', text: 'back to review because: the merge with UI-9 moved the button' })
  })
  it('Reject: the user\'s own screenshot is kept off the step, and the worker gets each picked one as a download with its key (WHR-294)', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-shots-'))
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(visual())
    await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'UI', name: 'UI', machine: '', path: '/src/ui', template: 'visual', addedAt: 1 }] }))
    const task = await store.addTask({ project: 'UI', title: 'New look', type: 'ui' })
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])
    const key = 'k'.repeat(32)
    await store.saveTask({ ...task, state: 'working', step: { ...working(), at: 2, shots: { work: [shot('after')] } }, shotToken: key })
    await expect(userShot(store, task.id, Buffer.from('nope'), 'image/png')).rejects.toMatchObject({ code: 'bad_input' })
    const { file } = await userShot(store, task.id, png, 'image/png')
    expect(await store.shot(task.id, file)).toEqual(png)
    expect((await store.task(task.id))?.step?.shots).toEqual({ work: [shot('after')] })
    await fs.writeFile(path.join(dir, 'shots', task.id, shot('after').file), png)
    const back = await userSendBack(store, task.id, 'The button is cut off', [file, shot('after').file, 'missing.png'])
    const fix = back.step!.fix!
    expect(fix).toContain('The button is cut off\n\nScreenshots the user points at:')
    expect(fix).toContain(`curl -fsS -H 'x-wherdr-shot-token: ${key}' 'http://127.0.0.1:`)
    expect(fix).toContain(`/api/pm/shot?task=${task.id}&file=${file}' -o ${file}`)
    expect(fix).not.toContain('missing.png')
  })
})
