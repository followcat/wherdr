<script setup lang="ts">
// A project's key badge, in its color (a --project-<color> theme token):
// the key alone (a coordinator's WHR) or a task id (WHR-52). `copy`: a tap
// copies the text with a short toast and nothing else opens (the card or the
// row under it stays closed). A span, so it can sit inside a card's button.
const props = defineProps<{ text: string, color?: string, copy?: boolean }>()

async function copyIt(e: Event) {
  e.stopPropagation()
  e.preventDefault()
  try {
    await navigator.clipboard.writeText(props.text)
    toast(`${tl('Copied')}: ${props.text}`)
  } catch { toast(tl('Copy failed'), true) }
}
</script>

<template>
  <span
    v-if="copy" class="project-badge copy" :style="color ? { '--key-c': projectColorVar(color) } : undefined" role="button" tabindex="0"
    :aria-label="`${tl('Copy')} ${text}`" :title="tl('Copy')" data-testid="project-badge"
    @click="copyIt" @keydown.enter="copyIt" @keydown.space="copyIt"
  >{{ text }}</span>
  <span v-else class="project-badge" :style="color ? { '--key-c': projectColorVar(color) } : undefined" data-testid="project-badge">{{ text }}</span>
</template>

<style scoped>
/* Text and border in the color, a light tint behind; no color: a plain chip. */
.project-badge {
  position: relative; display: inline-block; flex: none; padding: 0 5px; vertical-align: middle;
  border: 1px solid var(--key-c, var(--line-strong));
  color: color-mix(in srgb, var(--key-c, var(--text-2)) 55%, var(--text-strong));
  background: color-mix(in srgb, var(--key-c, transparent) 12%, transparent);
  font: 600 11px/1.6 var(--mono); letter-spacing: .04em; white-space: nowrap;
}
.copy { cursor: copy; }
/* A 44 px high hit area around the small chip. */
.copy::after { content: ''; position: absolute; inset: -13px -6px; }
.copy:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
