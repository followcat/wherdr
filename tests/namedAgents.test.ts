// Named agents (Settings › Agents): a name for a command on some machines,
// usable wherever a workflow pref names an agent.
import { describe, expect, it } from 'vitest'
import { agentsMissing, namedAgentError, readNamedAgents, type NamedAgent } from '../shared/pm/namedAgents'
import { agentLine, reviewerPlan, taskAgents, taskPrefsOf, workerPlan, type Task } from '../shared/pm/run'
import { parseCommand } from '../shared/pm/coordinator'
import { taskHistory } from '../shared/pm/history'
import { checkPrefs, validateTemplate, type Template, type WorkflowError } from '../shared/pm/workflow'

const sub: NamedAgent = { name: 'omp-sub', program: 'omp', command: 'omp-sub --thinking medium', machines: ['laptop'] }
const template: Template = {
  id: 'vibe', prefs: { agent: 'omp-sub', model: 'sonnet', reviewModel: 'opus' },
  taskTypes: { simple: { steps: [{ id: 'work', holder: 'worker', ends: 'report' }, { id: 'review', holder: 'reviewer', ends: 'verdict', sendBack: 'work' }] } },
}
const task: Task = { id: 'WEB-1', project: 'WEB', title: 'T', description: 'D', type: 'simple', state: 'todo', createdAt: 0 }

describe('named agents', () => {
  it('starts the command and its options, then the program\'s usual arguments', () => {
    const plan = workerPlan(template, task, [sub])
    expect(plan).toEqual({ program: 'omp', agent: 'omp-sub', command: 'omp-sub --thinking medium', model: 'sonnet' })
    expect(agentLine(plan as { program: string, command: string }, 'sonnet', '/h/i.md', undefined, undefined, ['/h/ctx']))
      .toBe(`exec omp-sub '--thinking' 'medium' '--add-dir' '/h/ctx' '--model' 'sonnet' 'Read /h/i.md and follow it.'`)
    // The reviewer defaults to the worker's named agent, with its own model.
    expect(reviewerPlan(template, task, undefined, [sub])).toMatchObject({ agent: 'omp-sub', program: 'omp', model: 'opus' })
    expect(workerPlan(template, task, [])).toEqual({ reason: expect.stringContaining('cannot start "omp-sub"') })
  })

  it('checks prefs against the known names, and any well-formed name when they are not known', () => {
    const errs = (p: unknown, named?: NamedAgent[]) => { const e: WorkflowError[] = []; checkPrefs(p, 'prefs', e, named); return e.map(x => x.path) }
    expect(errs({ agent: 'omp-sub', reviewAgent: 'codex' }, [sub])).toEqual([])
    expect(errs({ agent: 'other', reviewFallbackAgent: 'omp-sub' }, [sub])).toEqual(['prefs.agent'])
    expect(errs({ agent: 'other' })).toEqual([])
    expect(errs({ agent: 'Not a name!' })).toEqual(['prefs.agent'])
    expect(validateTemplate(template, [sub])).toEqual([])
  })

  it('keeps only valid entries, and never a key in the command', () => {
    expect(readNamedAgents(JSON.stringify([sub, { ...sub }, { ...sub, name: 'claude' }, { ...sub, name: 'bad', command: 'x; rm' }]))).toEqual([sub])
    expect(namedAgentError({ ...sub, command: 'omp-sub --api-key=abc' })).toMatch(/No key/)
    expect(namedAgentError({ ...sub, command: 'API_KEY=abc omp' })).toMatch(/No key|executable/)
    expect(namedAgentError({ ...sub, command: 'omp-sub --api-key placeholder' })).toMatch(/No key/)
    expect(namedAgentError({ ...sub, command: 'omp-sub --token placeholder' })).toMatch(/No key/)
    expect(namedAgentError({ ...sub, command: 'omp-sub --profile "account two"' })).toMatch(/no quotes/)
    expect(namedAgentError({ ...sub, command: 'omp-sub --profile=two' })).toBeUndefined()
    expect(namedAgentError({ ...sub, machines: [] })).toMatch(/machine/)
  })

  it('a machine without the task\'s named agent takes nothing, and says which one', () => {
    const needed = taskAgents(template, task, [sub])
    expect(agentsMissing(needed, [sub], 'laptop')).toBeUndefined()
    expect(agentsMissing(needed, [sub], 'desktop')).toBe('no named agent omp-sub (Settings › Agents)')
    // Plain programs need nothing.
    expect(taskAgents({ ...template, prefs: { agent: 'claude', model: 'opus', reviewModel: 'sonnet' } }, task, [sub])).toEqual([])
  })

  it('a task\'s own agent wins over its task type\'s, which wins over the project\'s', () => {
    const api: NamedAgent = { ...sub, name: 'omp-api', command: 'omp-api' }
    const t: Template = { ...template, prefs: { agent: 'claude', model: 'sonnet', reviewModel: 'opus' }, taskTypes: { simple: { ...template.taskTypes.simple!, prefs: { agent: 'codex' } } } }
    expect(workerPlan(t, task, [api])).toMatchObject({ program: 'codex' })
    expect(workerPlan({ ...t, taskTypes: { simple: template.taskTypes.simple! } }, task, [api])).toMatchObject({ program: 'claude' })
    const own = { ...task, prefs: { agent: 'omp-api', reviewAgent: 'claude' } }
    expect(workerPlan(t, own, [api])).toMatchObject({ agent: 'omp-api', program: 'omp', model: 'sonnet' })
    expect(reviewerPlan(t, own, undefined, [api])).toMatchObject({ program: 'claude', model: 'opus' })
  })

  it('task add --agent: a malformed name never parses, an unknown one is refused', () => {
    expect(parseCommand(['task', 'add', 'Fix it', '--type', 'simple', '--agent', 'omp-api', '--review-agent', 'codex'])).toMatchObject({ prefs: { agent: 'omp-api', reviewAgent: 'codex' } })
    expect(parseCommand(['task', 'add', 'Fix it', '--type', 'simple', '--agent', 'Not a name!'])).toEqual({ error: expect.stringContaining('--agent') })
    expect(parseCommand(['task', 'edit', 'WEB-1', '--agent', '', '--reason', 'back to the workflow'])).toMatchObject({ prefs: { agent: '' } })
    expect(taskPrefsOf({ agent: 'omp-sub' }, [sub])).toEqual({ prefs: { agent: 'omp-sub' } })
    expect(taskPrefsOf({ agent: 'omp-api' }, [sub])).toEqual({ errors: [{ path: 'prefs.agent', message: expect.stringContaining('cannot start "omp-api"') }] })
    expect(taskPrefsOf({ agent: '', reviewAgent: 'codex' }, [sub])).toEqual({ prefs: { reviewAgent: 'codex' } })
  })

  it('names each run\'s agent on the History line that logged its start', () => {
    const log = [
      { at: 1000, by: 'user', text: 'started the task' },
      { at: 5000, by: 'worker omp m', text: 'work: done' },
      { at: 6000, by: 'engine', text: 'review: started the reviewer (codex m)' },
    ]
    const starts = [{ at: 900, role: 'worker' as const, agent: 'omp-sub' }, { at: 6500, role: 'reviewer' as const, agent: 'codex' }, { at: 900_000, role: 'worker' as const, agent: 'late' }]
    expect(taskHistory(log, [{ id: 'work' }], undefined, true, [], starts).map(e => e.started))
      .toEqual([[{ role: 'worker', agent: 'omp-sub' }], undefined, [{ role: 'reviewer', agent: 'codex' }]])
  })
})
