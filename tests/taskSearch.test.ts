import { describe, expect, it } from 'vitest'
import { parseTaskRow, type TaskRow } from '../shared/projectsTasks'
import { type SearchableBoard, searchTasks, taskScore } from '../shared/taskSearch'

const row = (id: string, title: string, extra: Partial<TaskRow> = {}): TaskRow => ({ ...parseTaskRow({ id, title, state: 'idle', stage: 'todo' })!, repoKey: 'WHR', ...extra })
const board = (machine: string, tasks: [TaskRow, string?][]): SearchableBoard => ({ machine, tasks: tasks.map(([r, d]) => ({ row: r, description: d || '' })) })

describe('task search: matching', () => {
  it('matches the task name, with or without its separator and case', () => {
    const t = { row: row('wherdr/12', 'Fix login'), description: '' }
    for (const q of ['WHR-12', 'whr-12', 'whr12', '#12', 'wherdr/12']) expect(taskScore(t, q)?.score).toBe(0)
    expect(taskScore(t, 'WHR-1')).toMatchObject({ score: 1, field: 'id' })
    expect(taskScore(t, '12')).toMatchObject({ score: 1, field: 'id' })
    expect(taskScore(t, 'WHR-13')).toBeNull()
    // A name without its repo key (`#12`) still matches by number.
    expect(taskScore({ row: row('wherdr/12', 'x', { repoKey: undefined }), description: '' }, '#12')?.score).toBe(0)
  })

  it('matches the title and the description, ignoring accents', () => {
    const t = { row: row('app/3', 'Écran de connexion'), description: 'The **session** cookie expires too early.' }
    expect(taskScore(t, 'ecran')).toMatchObject({ score: 2, field: 'title' })
    expect(taskScore(t, 'connexion')).toMatchObject({ score: 3, field: 'title' })
    expect(taskScore(t, 'onnexion')).toMatchObject({ score: 4, field: 'title' })
    expect(taskScore(t, 'cookie')).toMatchObject({ score: 5, field: 'description' })
    expect(taskScore(t, 'nothing here')).toBeNull()
  })
})

describe('task search: ranking', () => {
  it('ranks the name first, then title, then description; open tasks and newer ones first', () => {
    const boards = [
      board('', [[row('wherdr/7', 'Notes about login', { group: 'done' })], [row('wherdr/8', 'Notes', {})], [row('wherdr/9', 'Refactor', {}), 'the login flow']]),
      board('laptop', [[row('side/4', 'Login page', { repoKey: 'SIDE' })], [row('side/5', 'Login form', { repoKey: 'SIDE', group: 'done' })]]),
    ]
    const { hits } = searchTasks(boards, 'login')
    expect(hits.map(h => h.key)).toEqual(['SIDE-4', 'SIDE-5', 'WHR-7', 'WHR-9'])
    expect(hits[0]).toMatchObject({ machine: 'laptop', id: 'side/4', repo: 'side', field: 'title', group: 'todo' })
    expect(hits[3]).toMatchObject({ field: 'description', excerpt: 'the login flow' })
    expect(searchTasks(boards, 'WHR-8').hits.map(h => h.id)).toEqual(['wherdr/8'])
  })

  it('caps the results and leaves archived tasks out', () => {
    const many = board('', Array.from({ length: 30 }, (_, i) => [row(`demo/${i + 1}`, `Task ${i + 1}`)] as [TaskRow]))
    const r = searchTasks([many], 'task', 5)
    expect(r.hits).toHaveLength(5)
    expect(r.limited).toBe(true)
    expect(r.hits[0]!.id).toBe('demo/30')
    expect(searchTasks([board('', [[row('demo/1', 'Old', { archived: true })]])], 'old').hits).toEqual([])
  })
})
