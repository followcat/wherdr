// Global search over the Board's tasks (herdr-projects 1.x): a task's name
// (`WHR-12`, or `#12` while its repo's key is unknown), its title and its
// description. Pure, so the server and the tests share it.
import { excerpt, foldSearch, matchAt } from './searchText'
import { type TaskGroup, type TaskRow, taskKey } from './projectsTasks'

export const TASK_SEARCH_MAX = 12

export interface TaskHit {
  machine: string // the base machine's key
  id: string // `<repo>/<n>`
  key: string // `WHR-12`, or `#12`
  repo: string
  title: string
  stage: string
  group: TaskGroup
  // Where the query matched; `excerpt`: the description around it.
  field: 'id' | 'title' | 'description'
  excerpt?: string
}

export interface SearchableTask { row: TaskRow, description: string }
export interface SearchableBoard { machine: string, tasks: SearchableTask[] }

const compact = (s: string) => foldSearch(s).replace(/[\s_-]+/g, '')

const WORD = /[\p{L}\p{N}]/u
function wordStart(text: string, q: string): boolean {
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) if (i === 0 || !WORD.test(text[i - 1]!)) return true
  return false
}

// Lower is better: the exact name, a name it starts, the title it starts, a
// word of the title it starts, the title, then the description. null: no match.
export function taskScore(t: SearchableTask, query: string): { score: number, field: TaskHit['field'], at: number } | null {
  const q = foldSearch(query.trim())
  if (!q) return null
  const key = taskKey(t.row.id, t.row.repoKey)
  const names = [key, t.row.id, `#${t.row.n}`].map(compact)
  const cq = compact(q)
  if (names.includes(cq)) return { score: 0, field: 'id', at: 0 }
  // A started name (`WHR-1` for `WHR-12`), or its number alone (`12`).
  if (/\d/.test(cq) && (cq === String(t.row.n) || names.some(n => n.startsWith(cq)))) return { score: 1, field: 'id', at: 0 }
  const title = foldSearch(t.row.title)
  const at = title.indexOf(q)
  if (at === 0) return { score: 2, field: 'title', at }
  if (at > 0) return { score: wordStart(title, q) ? 3 : 4, field: 'title', at }
  const d = matchAt(t.description, query.trim())
  return d < 0 ? null : { score: 5, field: 'description', at: d }
}

// Open tasks before done ones, then the newest first.
const GROUP_RANK: Record<TaskGroup, number> = { needs: 0, ready: 0, working: 0, todo: 0, done: 1 }

export function searchTasks(boards: SearchableBoard[], query: string, max = TASK_SEARCH_MAX): { hits: TaskHit[], limited: boolean } {
  const found: { hit: TaskHit, score: number, n: number }[] = []
  for (const b of boards) {
    for (const t of b.tasks) {
      if (t.row.archived) continue
      const m = taskScore(t, query)
      if (!m) continue
      found.push({
        score: m.score, n: t.row.n,
        hit: {
          machine: b.machine, id: t.row.id, key: taskKey(t.row.id, t.row.repoKey), repo: t.row.repo, title: t.row.title,
          stage: t.row.stage, group: t.row.group, field: m.field,
          ...(m.field === 'description' ? { excerpt: excerpt(t.description, m.at, 100, query.trim()) } : {}),
        },
      })
    }
  }
  found.sort((a, b) => a.score - b.score || GROUP_RANK[a.hit.group] - GROUP_RANK[b.hit.group] || b.n - a.n)
  return { hits: found.slice(0, max).map(f => f.hit), limited: found.length > max }
}
