import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { splitFeature } from '../server/utils/pmFeature'
import { REAL_ALL_SCRIPT, REAL_SCRIPT } from '../shared/pm/workspaceAdopt'
import { PREPARE_SCRIPT, PROBE_SCRIPT } from '../server/utils/pmFolder'
import { REMOTE_SCRIPT } from '../server/utils/pmVisibility'
import { afterRefusal, closeRefusal, featureState, parsePlan } from '../shared/pm/feature'
import { parseCommand } from '../shared/pm/coordinator'
import type { Project } from '../shared/pm/project'
import type { Task } from '../shared/pm/run'

const projects = [
  { key: 'WS', name: 'Work', machine: 'home', path: '/h/work', kind: 'workspace', git: false, addedAt: 1 },
  { key: 'PA', name: 'Payroll', machine: 'home', path: '/h/work/payroll-api', workspace: 'WS', addedAt: 1 },
  { key: 'QA', name: 'Quotes', machine: 'home', path: '/h/work/quotes-app', workspace: 'WS', addedAt: 1 },
  { key: 'OT', name: 'Other', machine: 'home', path: '/h/other', addedAt: 1 },
] as Project[]
const sub = (id: string, more: Partial<Task> = {}) => ({ id, project: id.split('-')[0]!, title: id, description: '', type: 'feature', state: 'todo', createdAt: 1, feature: 'WS-1', ...more }) as Task
const plan = (tasks: object[]) => ({ order: 'The API first: the app calls it', tasks })

describe('features: the plan, after and the derived state', () => {
  it('parses the commands and puts a plan in start order', () => {
    expect(parseCommand(['feature', 'add', 'Export', 'payslips', '--description', 'As PDF', '--project', 'WS'])).toEqual({ name: 'feature add', title: 'Export payslips', description: 'As PDF', project: 'WS' })
    expect(parseCommand(['feature', 'close', 'WS-1', '--reason', 'Shipped'])).toEqual({ name: 'feature close', task: 'WS-1', reason: 'Shipped' })
    expect(parseCommand(['task', 'edit', 'PA-1', '--after', 'QA-1', '--reason', 'The app first'])).toMatchObject({ after: 'QA-1' })
    const p = parsePlan(plan([{ repo: 'quotes-app', title: 'Show it', type: 'feature', after: ['payroll-api'] }, { repo: 'payroll-api', title: 'Serve it', type: 'feature' }]))
    expect('tasks' in p && p.tasks.map(t => t.repo)).toEqual(['payroll-api', 'quotes-app'])
    expect(parsePlan(plan([{ repo: 'a', title: 'A', type: 'x', after: ['b'] }, { repo: 'b', title: 'B', type: 'x', after: ['a'] }]))).toEqual({ error: 'plan: a cycle in after (a, b)' })
    // after and mergeAfter together: the API merges after the app, which starts after the API.
    expect(parsePlan(plan([{ repo: 'api', title: 'A', type: 'x', mergeAfter: ['app'] }, { repo: 'app', title: 'B', type: 'x', after: ['api'] }]))).toEqual({ error: 'plan: a cycle in after and mergeAfter (api, app)' })
    expect(parsePlan(plan([{ repo: 'a', title: 'A', type: 'x' }, { repo: 'a', title: 'B', type: 'x' }]))).toMatchObject({ error: expect.stringMatching(/twice/) })
  })

  it('links after across the workspace only, never into a cycle', () => {
    const tasks = [sub('PA-1'), sub('QA-1', { after: 'PA-1' }), sub('OT-1'), { ...sub('WS-1'), kind: 'feature' as const }]
    expect(afterRefusal('QA', ['PA-1'], tasks, projects)).toBeUndefined()
    expect(afterRefusal('QA', ['OT-1'], tasks, projects)).toMatch(/tasks of the same project or workspace, comma-separated \(not OT-1\)/)
    expect(afterRefusal('PA', ['WS-1'], tasks, projects)).toMatch(/not WS-1/)
    expect(afterRefusal('PA', ['QA-1'], tasks, projects, 'PA-1')).toMatch(/a cycle/)
    // A merge waiting on a task that starts after it: a cycle too.
    expect(afterRefusal('PA', ['QA-1'], tasks, projects, 'PA-1', 'mergeAfter')).toBe('PA-1 would wait for itself: a cycle in mergeAfter')
  })

  it('derives the feature\'s state from its sub-tasks, done once closed', () => {
    const f = { ...sub('WS-1'), feature: undefined, kind: 'feature' as const }
    const done = sub('PA-1', { step: { at: 0, started: true, done: true, proofs: {}, rounds: {} } })
    expect(featureState(f, [sub('PA-1')])).toBe('todo')
    // Its work ended but not closed yet: still working, never back to do.
    expect(featureState(f, [done])).toBe('working')
    expect(featureState(f, [done, sub('QA-1')])).toBe('working')
    expect(featureState(f, [done, sub('QA-1', { state: 'working' })])).toBe('working')
    expect(featureState(f, [done, sub('QA-1', { state: 'waiting', waiting: 'A question' })])).toBe('waiting')
    expect(closeRefusal(f, [done, sub('QA-1')])).toMatch(/QA-1 still open/)
    expect(closeRefusal(f, [done])).toBeUndefined()
    expect(featureState({ ...f, closed: { at: 1, by: 'x' } }, [done])).toBe('done')
  })
})

describe('feature split', () => {
  let dir = ''
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-feature-')) })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('in one call adds one sub-task per repository, chains them and starts those that wait for nothing; all or nothing', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects }))
    const feature = await store.addTask({ project: 'WS', title: 'Export payslips', type: 'feature' })
    expect(feature).toMatchObject({ id: 'WS-1', kind: 'feature' })
    const ws = projects[0]!, start = vi.fn(async () => {}), who = { by: 'coordinator WS', origin: 'user' as const }
    // The machine's answers for adopting /h/work/ledger.
    const call = async (_m: string, p: { argv: string[] }) => {
      const [, , script] = p.argv
      const out = script === REAL_ALL_SCRIPT ? p.argv.slice(4).map(a => `x${a}`).join('\n') : script === REAL_SCRIPT ? '/h/work\n/h/work/ledger' : script === PROBE_SCRIPT ? 'dir\ngit\nremote' : script === PREPARE_SCRIPT ? 'git' : script!.includes(REMOTE_SCRIPT.split('\n').at(-2)!) ? 'git@github.com:acme/ledger.git\n{"visibility":"PRIVATE"}' : script!.includes('$HOME') ? '/h' : ''
      return { code: 0, stdout: Buffer.from(out).toString('base64') }
    }
    const deps = { store, call, machines: () => [{ key: 'home', label: 'home', local: true }] } as never
    const split = (p: object) => splitFeature(deps, ws, feature, JSON.stringify(p), who, start)
    const keys = async () => (await store.projects()).map(p => p.key)
    // Refused whole: an unknown task type, a link outside the workspace.
    await expect(split(plan([{ repo: 'payroll-api', title: 'Serve', type: 'task' }, { repo: 'QA', title: 'Show', type: 'study' }]))).rejects.toThrow(/no task type "study"/)
    await store.addTask({ project: 'OT', title: 'Elsewhere', type: 'task' })
    await expect(split(plan([{ repo: 'payroll-api', title: 'Serve', type: 'task' }, { repo: 'QA', title: 'Show', type: 'task', after: ['OT-1'] }]))).rejects.toThrow(/after/)
    // A repository named twice (its key and its path), a bad link beside a new repository: nothing adopted.
    await expect(split(plan([{ repo: 'PA', title: 'Serve', type: 'task' }, { repo: 'payroll-api', title: 'Again', type: 'task' }]))).rejects.toThrow(/its repository twice/)
    await expect(split(plan([{ repo: 'ledger', title: 'Book', type: 'task', after: ['OT-1'] }]))).rejects.toThrow(/after/)
    // Refused after its adoption: the new member is removed again.
    const failing = vi.spyOn(store, 'splitFeature').mockRejectedValueOnce(new Error('disk full'))
    await expect(split(plan([{ repo: 'ledger', title: 'Book', type: 'task' }]))).rejects.toThrow(/disk full/)
    failing.mockRestore()
    // Its adoption failing once the member is saved (its log line): removed again too.
    const noLog = vi.spyOn(store, 'logProject').mockRejectedValueOnce(new Error('log full'))
    await expect(split(plan([{ repo: 'ledger', title: 'Book', type: 'task' }]))).rejects.toThrow(/log full/)
    noLog.mockRestore()
    expect(await keys()).toEqual(['WS', 'PA', 'QA', 'OT'])
    expect((await store.tasks()).filter(t => t.feature)).toEqual([])

    const r = await split(plan([{ repo: 'QA', title: 'Show it', type: 'task', after: ['payroll-api'] }, { repo: 'payroll-api', title: 'Serve it', type: 'task', files: ['api'] }]))
    expect(r.tasks).toEqual([{ id: 'PA-1', project: 'PA', title: 'Serve it' }, { id: 'QA-1', project: 'QA', title: 'Show it', after: 'PA-1' }])
    expect(r.started).toEqual(['PA-1'])
    expect(start).toHaveBeenCalledTimes(1)
    expect(await store.task('PA-1')).toMatchObject({ feature: 'WS-1', files: ['api'] })
    expect(await store.task('WS-1')).toMatchObject({ plan: { order: 'The API first: the app calls it' } })
    await expect(split(plan([{ repo: 'QA', title: 'Again', type: 'task' }]))).rejects.toThrow(/already split/)
  })
})
