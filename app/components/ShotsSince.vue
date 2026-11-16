<script setup lang="ts">
// What changed since the user's last look at a visual task (their last
// send-back): the note it answers, then each screenshot taken since, beside the
// version it redoes (a new screen alone). A tap opens the pair full size.
import { earlierCommit, sinceLastLook, shotUrl } from '#shared/pm/shots'
import type { StepState } from '#shared/pm/steps'

const props = defineProps<{ task: string, state?: StepState, step: string }>()
const since = computed(() => sinceLastLook(props.state, props.step))
const head = computed(() => props.state?.shotsHead?.[props.step])
const open = (srcs: string[], i: number) => openLightbox(srcs, i)
const srcs = (p: { before?: { file: string }, after: { file: string } }) => [...(p.before ? [shotUrl(props.task, p.before.file)] : []), shotUrl(props.task, p.after.file)]
</script>

<template>
  <section v-if="since && since.pairs.length" class="since" data-testid="shots-since">
    <span class="mono-label">{{ tl('Since your last look') }}</span>
    <blockquote class="since-note muted" data-testid="shots-since-note">{{ since.note }}</blockquote>
    <ul class="since-pairs">
      <li v-for="p in since.pairs" :key="p.after.file" class="since-pair" data-testid="shots-since-pair">
        <figure v-if="p.before">
          <button type="button" class="since-shot" :aria-label="tl('Previous version, full size')" @click="open(srcs(p), 0)">
            <img :src="shotUrl(task, p.before.file)" alt="" loading="lazy" decoding="async">
          </button>
          <figcaption class="mono-label muted">{{ tl('Before') }}</figcaption>
        </figure>
        <figure>
          <button type="button" class="since-shot" :aria-label="tl('New version, full size')" @click="open(srcs(p), p.before ? 1 : 0)">
            <img :src="shotUrl(task, p.after.file)" alt="" loading="lazy" decoding="async">
          </button>
          <figcaption class="mono-label muted">{{ p.before ? tl('Redone') : tl('New screen') }}<template v-if="earlierCommit(p.after, head)"> · {{ tl('Earlier commit') }}</template></figcaption>
        </figure>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.since { display: grid; gap: 8px; }
.since-note { margin: 0; padding-left: 10px; border-left: 2px solid var(--line); white-space: pre-wrap; }
.since-pairs { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.since-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.since-pair figure { margin: 0; display: grid; gap: 4px; min-width: 0; }
.since-shot { display: block; width: 100%; aspect-ratio: 16 / 10; min-height: 44px; padding: 0; border: 1px solid var(--line); background: var(--surface); cursor: zoom-in; overflow: hidden; }
.since-shot img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
</style>
