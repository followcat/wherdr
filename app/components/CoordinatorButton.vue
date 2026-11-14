<script setup lang="ts">
// A coordinator's one header button, on the board and in its conversation:
// a clock, its autopilot's state (green square: on, hollow while asleep), a
// count of what waits for the user (a conversation of another agent), and a
// tap opens its window (CoordinatorPanel). Only the autopilot: a proposed
// workflow change is a card in the conversation (WorkflowChange).
// Alfred has no autopilot: in its conversation the button is its Agent's, without a state.
import type { CoordinatorView } from '#shared/pm/coordinator'
import type CoordinatorPanel from '~/components/CoordinatorPanel.vue'

const props = defineProps<{ c: CoordinatorView, open?: boolean }>()
const sheet = ref(false)
const panel = ref<InstanceType<typeof CoordinatorPanel>>()
// Closing with unsaved autopilot settings asks first; kept open on no.
const sheetOpen = computed({ get: () => sheet.value, set: async (v: boolean) => { if (v || (await (panel.value?.leave() ?? true))) sheet.value = v } })
const on = computed(() => !!props.c.autopilot?.on)
const state = computed(() => (!on.value ? 'inactive' : props.c.asleep ? 'idle' : 'done'))
const stateText = computed(() => (!on.value ? tl('Off', 'Arrêté') : props.c.asleep ? tl('Asleep', 'Endormi') : tl('On', 'Actif')))
const pending = computed(() => Number(coordinatorMismatch(props.c)))
const word = computed(() => (props.c.main ? tl('Agent') : tl('Autopilot', 'Autopilote')))
const label = computed(() => `${word.value}${props.c.main ? '' : `: ${stateText.value}`}${pending.value ? ` · ${tl(`${pending.value} to review`, `${pending.value} à voir`)}` : ''}`)
const title = computed(() => (props.c.main ? tl(`${coordinatorName(props.c)}’s agent`) : `${word.value} · ${props.c.project}`))
</script>

<template>
  <UButton color="neutral" variant="outline" size="lg" class="coord-btn" :class="{ on }" :aria-label="label" :title="label" data-testid="coordinator-button" :data-state="state" @click.stop="sheet = true">
    <span v-if="!c.main" class="card-state" :class="state" aria-hidden="true"><i /></span>
    <UIcon :name="c.main ? 'i-lucide-bot' : 'i-lucide-clock'" class="coord-btn-icon" aria-hidden="true" />
    <span class="coord-btn-text">{{ word }}</span>
    <span v-if="pending" class="mono-label coord-btn-n" data-testid="coordinator-pending">{{ pending }}</span>
  </UButton>
  <AppSheet v-model:open="sheetOpen" :title="title" tall>
    <CoordinatorPanel ref="panel" :c="c" :open="open" />
  </AppSheet>
</template>

<style scoped>
.coord-btn { flex: none; gap: 8px; }
.coord-btn.on { color: var(--idle); }
.coord-btn .card-state.inactive i { background: transparent; box-shadow: inset 0 0 0 1.5px currentColor; }
.coord-btn-icon { width: 18px; height: 18px; }
/* Phone: an icon instead of the word, so the header keeps its title and pickers. */
@media (max-width: 599px) { .coord-btn { gap: 6px; padding-inline: 8px; } .coord-btn-text { display: none; } }
.coord-btn-n { min-width: 18px; padding: 0 4px; background: var(--blocked); color: var(--bg); text-align: center; }
</style>
