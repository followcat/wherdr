<script setup lang="ts">
// The task sheet over any page but the board (which shows its own): opened by
// ?task=ID on the current route (useTaskSheet.ts). The page under it stays
// mounted, so closing returns to it as it was (scroll, conversation).
import { waitsFor, type Board } from '#shared/pm/board'
import { storedTaskId } from '#shared/pm/projectKey'

const route = useRoute()
const id = computed(() => (route.path !== BOARD_PATH && typeof route.query.task === 'string' ? route.query.task : null))
const data = ref<Board | null>(null)
const load = () => api<Board>('/api/pm/board').then((b) => { data.value = b }, () => {})
let timer: ReturnType<typeof setInterval> | undefined
watch(id, (v) => {
  clearInterval(timer)
  if (!v) return
  load()
  timer = setInterval(() => { if (!document.hidden) load() }, 10_000)
}, { immediate: true })
watch(taskSheetTick, () => { if (id.value) load() })
watchTaskAgents()
onBeforeUnmount(() => clearInterval(timer))

// By any key its project had (a link may name a former key).
const onBoard = computed(() => {
  const b = data.value
  const want = b && id.value ? storedTaskId(b.projects, id.value) ?? id.value : null
  return b?.cards.find(c => c.id === want) ?? null
})
// An archived task is not among the board's cards: read on its own.
const archived = useArchivedCard(() => id.value, () => !!data.value && !onBoard.value)
const card = computed(() => onBoard.value ?? archived.value)
const pane = computed(() => (card.value?.terminal ? herdrState.value?.panes.find(p => p.coreAddress === card.value!.terminal) : undefined))
// The project's working branch, for the sheet's branch line.
const projectBase = computed(() => data.value?.projects.find(p => p.key === card.value?.project)?.base)
const waits = computed(() => (card.value?.phase === 'todo' ? waitsFor(card.value, data.value!.cards) : []))
</script>

<template>
  <TaskSheet v-if="card" :key="card.id" :card="card" :pane="pane" :waits-for="waits" :project-base="projectBase" @closed="closeTaskSheet" @changed="taskChanged" />
</template>
