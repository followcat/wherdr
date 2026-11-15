// The running agents of tasks (GET /api/pm/agents), by herdr-core address:
// their sidebar row, conversation header and search result name the task.
import { labelKey, type TaskAgent } from '#shared/pm/taskAgents'
import type { Pane } from '#shared/types'
import { taskAgentTitle } from '~/utils/taskAgentRow'

export const taskAgents = ref<Record<string, TaskAgent>>({})
// The rows' durations follow this clock, moved on with each read.
export const taskAgentsNow = ref(Date.now())
// An unchanged answer leaves the rows as they are.
export const loadTaskAgents = () => api<Record<string, TaskAgent>>('/api/pm/agents')
  .then((v) => {
    const next = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    if (JSON.stringify(next) !== JSON.stringify(taskAgents.value)) taskAgents.value = next
    markHomeLoad('agents', true)
  }, () => markHomeLoad('agents', false))
  .finally(() => { taskAgentsNow.value = Date.now() })

// By its address, else by its task and role labels (a re-attached or resumed terminal).
export const taskAgentOf = (p?: Pane | null) => (p?.coreAddress && taskAgents.value[p.coreAddress])
  || (p?.task && p.role ? taskAgents.value[labelKey(p.task, p.role)] : undefined)
// The pane's task title (without its key when a badge shows it), '' for a renamed pane or one that is no task's.
export const paneTaskTitle = (p?: Pane | null, withKey = true) => (p ? taskAgentTitle(p, taskAgentOf(p), withKey) : '')

// While the list is on screen: read now, then every 30 s while the page shows.
export function useTaskAgentsLoader() {
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => { loadTaskAgents(); timer = setInterval(() => { if (!document.hidden) loadTaskAgents() }, 30_000) })
  onBeforeUnmount(() => clearInterval(timer))
}
