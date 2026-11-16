<script setup lang="ts">
// A workspace's feature on the board (docs/workspaces.md#features): its title
// and id, the sub-tasks merged so far, one chip per sub-task (its key badge,
// step and state square; a tap opens its sheet), the merge order line and what
// still waits. A tap anywhere else opens the feature.
import type { Card } from '#shared/pm/board'
import type { ChipState, FeatureView } from '#shared/pm/featureCard'

defineProps<{ card: Card, view: FeatureView }>()
const emit = defineEmits<{ open: [id: string] }>()
// The state square's look (docs/design.md) and its words.
const LOOK: Record<ChipState, string> = { todo: 'inactive', working: 'working', waiting: 'blocked', done: 'done', abandoned: 'unknown' }
const SAID: Record<ChipState, string> = { todo: 'To do', working: 'Working', waiting: 'Waits for you', done: 'Merged', abandoned: 'Abandoned' }
</script>

<template>
  <div class="board-card feature-card" data-testid="feature-card" :data-task="card.id">
    <button type="button" class="feature-open" :aria-label="`${tl('Open the feature')}: ${card.title}`" @click="emit('open', card.id)" />
    <span class="board-card-head"><b>{{ card.title }}</b></span>
    <small class="mono-label board-card-id">
      <ProjectBadge :text="card.shown" :color="card.color" copy /> · <span data-testid="feature-progress">{{ view.merged }}/{{ view.chips.length }} {{ tl('merged') }}</span>
    </small>
    <span v-if="card.yourTurn" class="board-badge" data-testid="board-badge">{{ card.yourTurn }}</span>
    <span v-if="view.chips.length" class="feature-chips">
      <button
        v-for="s in view.chips" :key="s.id" type="button" class="board-chip feature-chip" :data-state="s.state"
        :aria-label="`${s.shown}: ${s.step ?? ''} ${tl(SAID[s.state])}`" data-testid="feature-chip" @click="emit('open', s.id)"
      >
        <ProjectBadge :text="s.shown" :color="s.color" />
        <span v-if="s.step" class="feature-step">{{ s.step }}</span>
        <span class="card-state" :class="LOOK[s.state]" role="img" :aria-label="tl(SAID[s.state])" :title="tl(SAID[s.state])"><i /></span>
      </button>
    </span>
    <small v-if="card.order" class="muted feature-line" :title="card.order" data-testid="feature-order">{{ tl('Order') }}: {{ card.order }}</small>
    <small v-for="w in view.waits" :key="w.shown" class="muted feature-line" data-testid="feature-waits">{{ w.shown }} {{ tl('waits for') }} {{ w.on.join(', ') }}</small>
  </div>
</template>

<style scoped>
/* The whole card opens the feature; the chips sit above that layer and open their sub-task. */
.feature-card { position: relative; }
.feature-open { position: absolute; inset: 0; border: 0; background: none; cursor: pointer; }
.feature-open:active { background: var(--surface-2); }
.feature-card :deep(.project-badge.copy), .feature-chip { position: relative; }
.feature-chips { display: flex; flex-wrap: wrap; gap: 4px; }
/* A chip: 44 px of hit height (docs/design.md) around a smaller drawn chip. */
.feature-chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; min-height: 32px; background: var(--surface); cursor: pointer; }
.feature-chip::after { content: ''; position: absolute; inset: -6px 0; }
.feature-chips { row-gap: 12px; padding: 6px 0; }
.feature-step { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feature-chip[data-state="abandoned"] .feature-step { text-decoration: line-through; }
.feature-line { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.feature-card .card-state.inactive i { background: transparent; box-shadow: inset 0 0 0 1.5px currentColor; }
</style>
