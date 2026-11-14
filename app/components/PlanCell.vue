<script setup lang="ts">
// Cell of a tab's plan (phone): agent, state, last line, and
// one-tap answer if the agent is waiting. Tapping the cell opens the pane full screen.
import type { Pane } from '#shared/types'

const props = defineProps<{ pane: Pane, focused?: boolean, fresh?: boolean }>()
const emit = defineEmits<{ open: [] }>()
const busy = ref(false)
const prompt = computed(() => (props.pane.status === 'blocked' && props.pane.prompt?.options?.length ? props.pane.prompt : null))
const quick = computed(() => quickChoices(prompt.value, 3))
const screen = computed(() => knownScreen(props.pane))
const line = computed(() => ((screen.value && screenSummary(screen.value)) || (prompt.value ? prompt.value.question : props.pane.preview)) || (props.pane.agent ? '' : shortPath(props.pane.cwd)))
async function pick(i: number, label: string) {
  busy.value = true
  if (!(await choose(props.pane.id, i, label, props.pane.prompt?.identity))) busy.value = false
}
watch(() => props.pane.prompt, () => { busy.value = false })
</script>

<template>
  <div
    class="plan-cell" :class="[statusKey(pane), { stale: paneStale(pane), fresh }]" role="button" tabindex="0" :data-pane="pane.id"
    @click="emit('open')" @keydown.enter.self="emit('open')"
  >
    <!-- Long press on the header: handled by the plan (TabView), along with dragging. -->
    <HeaderMenu :items="() => paneItems(pane)" :title="paneTitle(pane)" manual-press>
      <div class="plan-cell-head">
        <AgentAvatar :agent="pane.agent" />
        <span class="plan-cell-title">{{ paneTitle(pane) }}</span>
        <span v-if="focused" class="plan-cell-focus" :title="t('Active pane in Herdr')" />
        <SpaceMenu :items="() => paneItems(pane)" :title="paneTitle(pane)" size="sm" :label="t('Pane options')" />
      </div>
    </HeaderMenu>
    <StatusPill :pane="pane" model />
    <code v-if="prompt?.detail" class="plan-cell-detail">{{ detailLine(prompt.detail) }}</code>
    <p v-if="line" class="plan-cell-line">{{ line }}</p>
    <div v-if="quick.length" class="plan-cell-choices">
      <button
        v-for="o in quick" :key="o.i" type="button"
        :disabled="busy || prompt?.unavailable || !linkShown || offlineView || paneStale(pane)" @click.stop="pick(o.i, o.label)"
      >
        <span class="n">{{ o.i + 1 }}</span><span class="l">{{ o.label }}</span>
      </button>
    </div>
  </div>
</template>
