// Project management in the browser demo: the board, Tasks to review, Alfred and
// the coordinators, drawn from projects.ts by the app's own code (shared/pm), as
// the server does. The user's button and an answer to an agent's question move a
// task like the real engine; nothing runs and nothing leaves the page.
import { boardColumns, cardOf, toHandle, type Board, type Card } from '../../shared/pm/board'
import { decisionsOf } from '../../shared/pm/decisions'
import { onEvent, planSteps } from '../../shared/pm/steps'
import { publicTask, taskPlan, type Task } from '../../shared/pm/run'
import { MAIN, type CoordinatorView } from '../../shared/pm/coordinator'
import * as P from './projects'

type Reply = { status: number, body: unknown }
const ok = (body: unknown): Reply => ({ status: 200, body })

export class DemoPm {
  private tasks: Task[]
  private runs
  private projects = P.projects()

  constructor(private clock: { now: () => number, setTimeout: (fn: () => void, ms: number) => unknown }) {
    this.tasks = P.tasks(clock.now())
    this.runs = P.runs(clock.now())
  }

  private plan(t: Task) { return taskPlan(P.TEMPLATE, t, this.projects.find(p => p.key === t.project)) }

  board(): Board {
    const now = this.clock.now()
    const done = (t: Task) => !!t.step?.done
    const card = (t: Task): Card => ({ ...cardOf(t, this.plan(t), this.runs, now), ...(this.projects.find(p => p.key === t.project)?.color ? { color: this.projects.find(p => p.key === t.project)!.color } : {}) })
    const plans = Object.keys(P.TEMPLATE.taskTypes).map(type => ({ id: type, steps: planSteps(P.TEMPLATE, { type }, 'main') }))
    return {
      projects: this.projects.map(p => ({ key: p.key, name: p.name, base: 'main', ...(p.color ? { color: p.color } : {}), columns: boardColumns(plans.map(x => x.steps)), types: plans.map(x => ({ id: x.id, plan: x.steps.map(s => s.id).join(' → ') })) })),
      cards: [...this.tasks.filter(t => !done(t)), ...this.tasks.filter(done)].map(card),
      archived: {},
    }
  }

  coordinators(): CoordinatorView[] {
    const agent = { program: 'claude' as const }
    return [
      { project: MAIN, main: true, name: 'Alfred', agent, ran: agent, terminal: P.ALFRED_AT },
      ...this.projects.map(p => ({ project: p.key, name: p.name, ...(p.coordinatorName ? { coordinatorName: p.coordinatorName } : {}), ...(p.color ? { color: p.color } : {}), template: 'standard', agent, ran: agent, terminal: p.key === 'API' ? P.API_COORD_AT : P.WEB_COORD_AT })),
    ]
  }

  get(path: string): Reply | null {
    switch (path) {
      case '/api/alfred': return ok({ name: 'Alfred', program: 'claude', ran: 'claude', terminal: P.ALFRED_AT })
      case '/api/pm/coordinators': return ok(this.coordinators())
      case '/api/pm/overview': return ok({ enabled: true, projects: this.projects, templates: [{ id: 'standard', version: 1 }] })
      case '/api/pm/board': return ok(this.board())
      case '/api/pm/handle': return ok(toHandle(this.board().cards))
      case '/api/pm/decisions': return ok(decisionsOf({ cards: this.board().cards, tasks: this.tasks, coordinators: [], wakes: [], now: this.clock.now() }))
      case '/api/pm/logins': return ok([])
    }
    return null
  }

  post(path: string, body: Record<string, unknown>): Reply | null {
    const t = this.tasks.find(x => x.id === body.id)
    if (path === '/api/pm/step-user' && t) return this.press(t)
    if (path === '/api/pm/answer' && t) return this.answer(t, String(body.text || ''))
    return null
  }

  private set(t: Task, patch: Partial<Task>) {
    const next = { ...t, ...patch }
    this.tasks = this.tasks.map(x => (x.id === t.id ? next : x))
    return next
  }

  private log(t: Task, by: string, text: string) { return [...t.log ?? [], { at: this.clock.now(), by, text }] }

  // The step's button (Merge): the task moves on; an engine action (the merge)
  // then ends in a moment, as if it went through.
  private press(t: Task): Reply {
    const r = onEvent(this.plan(t), t.step!, { kind: 'user' }, this.clock.now())
    if (r.refused) return { status: 409, body: { error: r.refused, code: 'refused' } }
    const next = this.set(t, { step: r.state, log: this.log(t, 'you', 'Approved') })
    if (!r.state.done) {
      this.clock.setTimeout(() => {
        const cur = this.tasks.find(x => x.id === t.id)!
        this.set(cur, { step: { ...cur.step!, at: this.plan(cur).length - 1, done: true, yourTurn: undefined }, log: this.log(cur, 'engine', 'Merged PR #41 (demo: nothing was merged)') })
      }, 2500)
    }
    return ok({ task: publicTask(next) })
  }

  // An answer to the agent's question: it goes back to work.
  private answer(t: Task, text: string): Reply {
    if (t.state !== 'waiting') return { status: 409, body: { error: 'The task no longer waits', code: 'stale' } }
    const { waiting: _w, waitKind: _k, question: _q, questionTldr: _t, ...rest } = t
    this.tasks = this.tasks.map(x => (x.id === t.id ? { ...rest, state: 'working', log: this.log(t, 'you', `Answered: ${text}`) } : x))
    return ok({ ok: true })
  }
}
