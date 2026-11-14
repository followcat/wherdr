<script setup lang="ts">
// A task's screenshots an agent showed (`ui show shots`, shared/uiShow.ts):
// each step's set, as in the task sheet (TaskShots.vue: before and after side
// by side, toggled on a phone). "Open task" for the rest; approving goes
// through the task sheet or the agent's `ui action step` button.
import type { Board } from '#shared/pm/board'
import { storedTaskId } from '#shared/pm/projectKey'
import { shotMode } from '#shared/pm/shots'

const props = defineProps<{ task: string }>()
const board = ref<Board | null>(null)
const failed = ref(false)
const load = () => api<Board>('/api/pm/board').then((b) => { board.value = b; failed.value = false }, () => { failed.value = true })
onMounted(load)
watch(taskSheetTick, load)
const card = computed(() => {
  const b = board.value, id = b && storedTaskId(b.projects, props.task)
  return b?.cards.find(c => c.id === (id ?? props.task)) ?? null
})
const steps = computed(() => (card.value?.plan ?? []).filter(s => card.value?.state?.shots?.[s.id]?.length))
</script>

<template>
  <div class="ui-show-shots" data-testid="ui-show-shots">
    <p v-if="failed" class="muted">{{ t('Could not load the task') }}</p>
    <template v-else-if="card">
      <section v-for="s in steps" :key="s.id">
        <span class="mono-label">{{ s.column || s.id }}</span>
        <TaskShots :task="card.id" :shots="card.state!.shots![s.id]!" :mode="shotMode(s)" />
      </section>
      <p v-if="!steps.length" class="muted">{{ t('No screenshots yet') }}</p>
      <UButton color="neutral" variant="outline" icon="i-lucide-square-arrow-out-up-right" class="ui-show-task" @click="openTaskSheet(task)">
        {{ tl(`Open ${task}`) }}
      </UButton>
    </template>
  </div>
</template>

<style scoped>
.ui-show-shots { display: grid; gap: 16px; padding: 16px; }
.ui-show-shots section { display: grid; gap: 8px; }
.ui-show-task { min-height: 44px; justify-self: start; }
</style>
