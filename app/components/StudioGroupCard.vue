<script setup lang="ts">
// Collapsible backlot studio row of the Home list: state square, studio id,
// machine/session tag, waiting badge, chevron; inside, one ordinary AgentCard
// per role. In W1 the header only folds/unfolds the group.
import type { StudioGroup } from '~/utils/studioGroups'
import { studioRoleTitle } from '~/utils/studioGroups'

const props = defineProps<{ group: StudioGroup, open: boolean, machineLabel?: string }>()
const emit = defineEmits<{ toggle: [] }>()
const status = computed(() => statusKey(props.group.lead))
const stateText = computed(() => statusLabel(props.group.lead))
const machine = computed(() => props.machineLabel || props.group.machineLabel)
const machineTag = computed(() => tl(`[${machine.value} · ${props.group.session}]`))
const forced = computed(() => props.group.waitingCount > 0)
function toggle() { if (!forced.value) emit('toggle') }
</script>

<template>
  <section class="studio-group" :class="[status, { open }]" :data-studio-key="group.key" data-testid="studio-group">
    <div class="studio-group-head">
      <button
        type="button" class="studio-group-body" :aria-expanded="open" :disabled="forced"
        :title="forced ? t('Answer the waiting role first') : (open ? t('Collapse studio') : t('Expand studio'))"
        data-testid="studio-group-body" @click="toggle"
      >
        <span class="card-state" :class="status" :title="stateText" role="img" :aria-label="stateText"><i /></span>
        <span class="studio-group-title" data-testid="studio-group-title">{{ group.title }}</span>
        <span class="card-tag studio-group-machine" :title="machineTag" data-testid="studio-group-machine">{{ machineTag }}</span>
        <b v-if="group.waitingCount" class="studio-group-waiting" data-testid="studio-group-waiting">{{ tl(`!${group.waitingCount}`) }}</b>
      </button>
      <button
        type="button" class="studio-group-toggle" :aria-label="open ? t('Collapse studio') : t('Expand studio')" :aria-expanded="open" :disabled="forced"
        data-testid="studio-group-toggle" @click="toggle"
      ><UIcon :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" aria-hidden="true" /></button>
    </div>
    <div v-if="open" class="studio-group-roles">
      <div v-for="row in group.rows" :key="row.key" class="studio-role-wrap" data-testid="studio-role">
        <AgentCard :pane="row.lead" :row="row" :title-override="studioRoleTitle(row.lead)" agent-subtitle />
      </div>
    </div>
  </section>
</template>

<style scoped>
.studio-group { background: var(--bg-2); border-bottom: 1px solid var(--line-soft); }
.studio-group:not(:first-child) { border-top: 1px solid var(--line-soft); }
.studio-group:last-child { border-bottom: 0; }
.studio-group + .studio-group { border-top: 0; }
.studio-group.open .studio-group-head { border-bottom: 1px solid var(--line-soft); }
.studio-group-head { display: flex; align-items: stretch; min-height: 44px; }
.studio-group-body {
  flex: 1; min-width: 0; min-height: 44px; display: flex; align-items: center; gap: 8px;
  padding: 4px 0 4px 12px; border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer;
  touch-action: manipulation;
}
.studio-group-body:disabled { cursor: default; }
.studio-group-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 600; }
.studio-group.blocked .studio-group-title { color: var(--rose); }
.studio-group-machine { flex: none; max-width: 40%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-group-waiting {
  flex: none; padding: 2px 5px; border: 1px solid var(--ochre); color: var(--ochre);
  font: 600 10px/1 var(--mono); letter-spacing: .04em;
}
.studio-group-toggle {
  flex: none; width: 44px; height: 44px; display: grid; place-items: center; padding: 0; border: 0;
  background: transparent; color: var(--muted); cursor: pointer; touch-action: manipulation;
}
.studio-group-toggle:disabled { color: var(--dim); cursor: default; }
.studio-group-toggle .iconify { width: 18px; height: 18px; }
.studio-role-wrap + .studio-role-wrap { border-top: 1px solid var(--line-soft); }
.studio-group-roles :deep(.card) { border-top: 0; }
</style>
