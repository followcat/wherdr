<script setup lang="ts">
// A coordinator's one header button, on the board and in its conversation:
// its autopilot's state (green square: on, hollow while asleep), a count of
// what waits for the user (a proposed template change, a conversation of
// another agent), and a tap opens its window (CoordinatorPanel) with all the rest.
import type { CoordinatorView } from '#shared/pm/coordinator'

const props = defineProps<{ c: CoordinatorView, open?: boolean }>()
const sheet = ref(false)
const on = computed(() => !!props.c.autopilot?.on)
const state = computed(() => (!on.value ? 'inactive' : props.c.asleep ? 'idle' : 'done'))
const stateText = computed(() => (!on.value ? tl('Off', 'Arrêté') : props.c.asleep ? tl('Asleep', 'Endormi') : tl('On', 'Actif')))
const pending = computed(() => Number(!!props.c.proposal) + Number(coordinatorMismatch(props.c)))
const label = computed(() => `${tl('Autopilot', 'Autopilote')}: ${stateText.value}${pending.value ? ` · ${tl(`${pending.value} to review`, `${pending.value} à voir`)}` : ''}`)
const title = computed(() => `${tl('Autopilot', 'Autopilote')} · ${props.c.main ? props.c.name || 'Alfred' : props.c.project}`)
</script>

<template>
  <UButton color="neutral" variant="outline" size="lg" class="coord-btn" :class="{ on }" :aria-label="label" :title="label" data-testid="coordinator-button" :data-state="state" @click.stop="sheet = true">
    <span class="card-state" :class="state" aria-hidden="true"><i /></span>
    <UIcon name="i-lucide-plane" class="coord-btn-icon" aria-hidden="true" />
    <span class="coord-btn-text">{{ tl('Autopilot', 'Autopilote') }}</span>
    <span v-if="pending" class="mono-label coord-btn-n" data-testid="coordinator-pending">{{ pending }}</span>
  </UButton>
  <AppSheet v-model:open="sheet" :title="title" tall>
    <CoordinatorPanel :c="c" :open="open" />
  </AppSheet>
</template>

<style scoped>
.coord-btn { flex: none; gap: 8px; }
.coord-btn.on { color: var(--idle); }
.coord-btn .card-state.inactive i { background: transparent; box-shadow: inset 0 0 0 1.5px currentColor; }
.coord-btn-icon { display: none; width: 18px; height: 18px; }
/* Phone: an icon instead of the word, so the header keeps its title and pickers. */
@media (max-width: 599px) { .coord-btn { gap: 6px; padding-inline: 8px; } .coord-btn-text { display: none; } .coord-btn-icon { display: block; } }
.coord-btn-n { min-width: 18px; padding: 0 4px; background: var(--blocked); color: var(--bg); text-align: center; }
</style>
