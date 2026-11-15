<script setup lang="ts">
// Tasks to review: one card on Home with the count of what waits for the user
// (the board's Your turn, GET /api/pm/handle: tasks to approve, an agent's
// question, a failure to try again, a decision) on the projects the home tab
// shows (useMachineBar.projectOnBar), right under Alfred, above the
// coordinators; hidden when nothing waits. Under its title, the id badges of the
// first ones in their projects' colors, on one line ending with … when they do
// not all fit. A tap opens ReviewSheet, one at a time.
import type { ToHandle } from '#shared/pm/board'

const all = ref<ToHandle[]>([])
const tasks = computed(() => all.value.filter(x => projectOnBar(x.project)))
const load = () => api<ToHandle[]>('/api/pm/handle').then((v) => { all.value = Array.isArray(v) ? v : []; markHomeLoad('handle', true) }, () => markHomeLoad('handle', false))
let timer: ReturnType<typeof setInterval> | undefined
// Read while the card is on screen: a hidden page waits for the next tick it is shown.
onMounted(() => { load(); timer = setInterval(() => { if (!document.hidden) load() }, 15_000) })
onBeforeUnmount(() => clearInterval(timer))
watch(taskSheetTick, load) // an action in a task's sheet or the review sheet
watch(homeRetryTick, () => { if (homeFirstLoad.handle !== 'ok') load() }) // the home list's Try again
const show = (v: boolean) => { reviewOpen.value = v }
</script>

<template>
  <section v-if="tasks.length" class="agent-group review-group" data-testid="tasks-to-review">
    <button type="button" class="review-card press-row" data-testid="review-open" @click="show(true)">
      <span class="review-count" data-testid="review-count">{{ tasks.length }}</span>
      <span class="review-text">
        <b>{{ tl('Tasks to review') }}</b>
        <small class="review-ids" data-testid="review-ids"><ProjectBadge v-for="x in tasks.slice(0, 12)" :key="x.id" :text="x.shown" :color="x.color" /></small>
      </span>
      <UIcon name="i-lucide-chevron-right" class="review-go" />
    </button>
  </section>
  <ReviewSheet v-if="reviewOpen" @closed="show(false)" />
</template>

<style scoped>
.review-card { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; min-height: 56px; padding: 10px 12px; border: 1px solid var(--line); border-left: 2px solid var(--blocked); background: var(--surface); color: var(--text); text-align: left; cursor: pointer; }
.review-card:hover { background: var(--surface-2); }
.review-card:focus-visible { outline: 1px solid var(--mauve); outline-offset: -1px; }
.review-count { flex: none; min-width: 28px; color: var(--blocked); font: 600 20px/1 var(--display); text-align: center; }
.review-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.review-text b { font: 600 14px/1.3 var(--display); }
.review-text small { overflow: hidden; color: var(--muted); font: 12px/1.4 var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.review-ids { line-height: 20px; }
.review-ids :deep(.project-badge) { margin-right: 6px; }
.review-go { flex: none; color: var(--muted); }
</style>
