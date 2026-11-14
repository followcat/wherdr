<script setup lang="ts">
// A step's screenshots in the task sheet: thumbnails; a tap opens the image
// viewer on the whole set (full size, swipe or ← → between images). Before and
// after are side by side on a computer, and toggled on the phone.
import { shotRows, shotUrl, type Shot, type ShotPhase } from '#shared/pm/shots'
import type { ShotMode } from '#shared/pm/workflow'

const props = defineProps<{ task: string, shots: Shot[], mode: ShotMode }>()
const side = ref<ShotPhase>('after')
const compare = computed(() => props.mode === 'before-after')
const rows = computed(() => shotRows(props.shots, props.mode))
const phases = computed<ShotPhase[]>(() => (compare.value ? ['before', 'after'] : ['after']))
// The viewer's set, in the order shown: each row's before, then its after.
const srcs = computed(() => rows.value.flatMap(r => phases.value.flatMap(p => (r[p] ? [shotUrl(props.task, r[p]!.file)] : []))))
const open = (s: Shot) => openLightbox(srcs.value, srcs.value.indexOf(shotUrl(props.task, s.file)))
const reworked = computed(() => props.shots.some(s => s.rework))
const label = (p: ShotPhase) => (p === 'before' ? tl('Before', 'Avant') : tl('After', 'Après'))
</script>

<template>
  <div class="shots" :class="{ compare }" :data-side="side" data-testid="task-shots">
    <span v-if="reworked" class="mono-label muted" data-testid="shots-rework">{{ tl('After rework') }}</span>
    <div v-if="compare" class="shots-toggle" role="group" :aria-label="tl('Show', 'Afficher')">
      <UButton
        v-for="p in phases" :key="p" size="sm" color="neutral" :variant="side === p ? 'solid' : 'outline'"
        :aria-pressed="side === p" :data-testid="`shots-${p}`" @click="side = p"
      >
        {{ label(p) }}
      </UButton>
    </div>
    <div v-if="compare" class="shots-row shots-head" aria-hidden="true">
      <span v-for="p in phases" :key="p" class="mono-label" :class="p">{{ label(p) }}</span>
    </div>
    <ul class="shots-grid">
      <li v-for="(r, i) in rows" :key="i" class="shots-row">
        <template v-for="p in phases" :key="p">
          <button v-if="r[p]" type="button" class="shot" :class="p" :aria-label="tl(`${label(p)} ${i + 1}, full size`, `${label(p)} ${i + 1}, en grand`)" data-testid="shot" @click="open(r[p]!)">
            <img :src="shotUrl(task, r[p]!.file)" alt="" loading="lazy" decoding="async">
          </button>
          <span v-else class="shot none muted" :class="p">{{ tl('None', 'Aucune') }}</span>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.shots { display: grid; gap: 8px; }
.shots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.shots.compare .shots-grid { grid-template-columns: 1fr; }
.shots-row { display: grid; gap: 8px; }
.shots.compare .shots-row { grid-template-columns: 1fr 1fr; }
.shot { display: block; width: 100%; aspect-ratio: 16 / 10; min-height: 44px; padding: 0; border: 1px solid var(--line); background: var(--surface); cursor: zoom-in; overflow: hidden; }
.shot img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.shot.none { display: grid; place-items: center; cursor: default; font: 500 12px/1 var(--mono); }
.shots-toggle { display: none; gap: 8px; }
.shots-toggle > button { min-height: 44px; flex: 1; justify-content: center; }
/* Phone: one side at a time, chosen with the toggle. */
@media (max-width: 699px) {
  .shots.compare .shots-toggle { display: flex; }
  .shots.compare .shots-head { display: none; }
  .shots.compare .shots-grid { grid-template-columns: 1fr 1fr; }
  .shots.compare .shots-grid > .shots-row { display: contents; }
  .shots.compare[data-side='before'] .after, .shots.compare[data-side='after'] .before { display: none; }
}
</style>
