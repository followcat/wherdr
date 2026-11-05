<script setup lang="ts">
// A task's sheet: its Plan (the steps, the current one, what its holder was
// told, the proofs and rounds), its links, the agent holding the step, and
// the step's button when it waits for the user ("Merged").
import type { Card } from '#shared/pm/board'
import type { Pane } from '#shared/types'
import { shotMode } from '#shared/pm/shots'

const props = defineProps<{ card: Card, pane?: Pane }>()
const emit = defineEmits<{ closed: [], changed: [] }>()
const open = ref(true)
const busy = ref(false)
const error = ref('')

const at = computed(() => (props.card.state?.started ? props.card.state.at : -1))
const done = computed(() => !!props.card.state?.done)
const proofs = (id: string) => Object.entries(props.card.state?.proofs[id] ?? {}).filter(([, v]) => v)
const rounds = (id: string) => props.card.state?.rounds[id] ?? 0
// The steps that have screenshots, to look at before the push, the PR or the merge.
const shotSteps = computed(() => props.card.plan.filter(s => props.card.state?.shots?.[s.id]?.length))

async function press() {
  busy.value = true
  error.value = ''
  try { await api('/api/pm/step-user', { id: props.card.id }); emit('changed') }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <AppSheet v-model:open="open" :title="card.title" tall hide-close @closed="emit('closed')">
    <div class="task-sheet" data-testid="task-sheet">
      <p class="mono-label">{{ card.id }}<template v-if="card.step"> · {{ card.step }}</template></p>
      <p v-if="card.yourTurn" class="board-badge">{{ card.yourTurn }}</p>
      <p v-if="card.description" class="task-desc">{{ card.description }}</p>
      <div v-if="card.tags.length || card.links.length" class="board-tags">
        <span v-for="tag in card.tags" :key="tag" class="board-chip">{{ tag }}</span>
        <a v-for="l in card.links" :key="l.url" :href="l.url" target="_blank" rel="noopener" class="board-chip">{{ l.label }}</a>
      </div>
      <div class="task-sheet-actions">
        <UButton v-if="card.userLabel" color="primary" size="xl" :loading="busy" data-testid="step-user" @click="press">{{ card.userLabel }}</UButton>
        <UButton v-if="pane" color="neutral" variant="outline" size="xl" icon="i-lucide-terminal" :to="panePath(pane.id)">
          {{ card.holder === 'reviewer' ? tl('Open the reviewer', 'Ouvrir le relecteur') : tl('Open the agent', 'Ouvrir l’agent') }}
        </UButton>
      </div>
      <p v-if="error" class="error">{{ error }}</p>

      <template v-if="shotSteps.length">
        <h3 class="mono-label">{{ tl('Screenshots', 'Captures') }}</h3>
        <section v-for="s in shotSteps" :key="s.id" class="task-shots">
          <span v-if="shotSteps.length > 1" class="mono-label muted">{{ s.id }}</span>
          <TaskShots :task="card.id" :shots="card.state!.shots![s.id]!" :mode="shotMode(s)" />
        </section>
      </template>

      <h3 class="mono-label">{{ tl('Plan', 'Plan') }}</h3>
      <ol class="task-plan" data-testid="task-plan">
        <li v-for="(s, i) in card.plan" :key="s.id" :class="{ now: i === at && !done, past: i < at || done }" :aria-current="i === at && !done ? 'step' : undefined">
          <span class="mono-label">{{ s.id }} · {{ s.column || s.id }}<template v-if="s.holder && s.holder !== 'none'"> · {{ s.holder }}</template><template v-if="rounds(s.id)"> · {{ tl(`${rounds(s.id)} send-backs`, `${rounds(s.id)} renvois`) }}</template></span>
          <details v-if="s.text && s.holder && s.holder !== 'none'">
            <summary>{{ tl('Instructions', 'Consignes') }}</summary>
            <p class="task-desc">{{ s.text }}</p>
          </details>
          <small v-for="[k, v] in proofs(s.id)" :key="k" class="muted">{{ k }}: <a v-if="/^https?:\/\//.test(v)" :href="v" target="_blank" rel="noopener">{{ v }}</a><template v-else>{{ v }}</template></small>
        </li>
      </ol>

      <template v-if="card.log.length">
        <h3 class="mono-label">{{ tl('Log', 'Journal') }}</h3>
        <ol class="task-log" data-testid="task-log">
          <li v-for="(e, i) in [...card.log].reverse()" :key="i">
            <span class="mono-label muted">{{ new Date(e.at).toLocaleString() }} · {{ e.by }}</span>
            <span class="task-desc">{{ e.text }}</span>
          </li>
        </ol>
      </template>
    </div>
  </AppSheet>
</template>

<style scoped>
.task-sheet { display: flex; flex-direction: column; gap: 10px; padding: 0 16px 16px; }
.task-sheet p, .task-sheet h3 { margin: 0; }
.task-desc { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2); }
.task-sheet-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.task-shots { display: grid; gap: 6px; }
.task-plan { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.task-plan li { display: flex; flex-direction: column; gap: 4px; padding: 8px 0 8px 12px; border-bottom: 1px solid var(--line-soft); border-left: 2px solid transparent; }
.task-plan li.past { color: var(--muted); }
.task-plan li.now { border-left-color: var(--accent); }
.task-log { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.task-log li { display: grid; gap: 2px; padding: 6px 0; border-bottom: 1px solid var(--line-soft); }
.task-plan summary { cursor: pointer; min-height: 32px; display: flex; align-items: center; }
</style>
