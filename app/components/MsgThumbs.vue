<script setup lang="ts">
// Thumbnails of a message: wrapping grid, "+N" tile past the cap; a tap opens
// the viewer on the whole set of the message. `dupes`: images already shown
// higher up (see shared/imageDupes.ts), reduced to a small link.
const props = defineProps<{ srcs: string[], offline?: boolean, max?: number, dupes?: ReadonlySet<string> }>()
const fresh = computed(() => props.srcs.map((src, i) => ({ src, i })).filter(x => !props.dupes?.has(x.src)))
const repeated = computed(() => props.srcs.map((src, i) => ({ src, i })).filter(x => props.dupes?.has(x.src)))
const layout = computed(() => thumbLayout(fresh.value.length, props.max))
function open(i: number) { openLightbox(props.srcs, i) }
</script>

<template>
  <span class="thumbs" :class="{ one: fresh.length === 1 }">
    <span v-for="x in fresh.slice(0, layout.shown)" :key="x.src">
      <span v-if="offline" class="offline-image">{{ t('Image unavailable offline') }}</span>
      <ThumbImg v-else :src="x.src" @open="open(x.i)" />
    </span>
    <button v-if="layout.more" type="button" class="thumb-more" :aria-label="tl(`Show all ${fresh.length} images`, `Voir les ${fresh.length} images`)" @click="open(fresh[layout.shown]!.i)">
      <img v-if="!offline" :src="fresh[layout.shown]!.src" alt="" loading="lazy" decoding="async">
      <span>+{{ layout.more }}</span>
    </button>
    <button v-for="x in repeated" :key="x.src" type="button" class="thumb-dupe" :disabled="offline" @click="open(x.i)">
      ↑ {{ tl('Same image as above', 'Image déjà affichée plus haut') }}
    </button>
  </span>
</template>
