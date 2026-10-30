<script setup lang="ts">
import type { TerminalCopySnapshot } from '~/utils/terminalCopy'
import { copyNativeSelection, selectedCopyText } from '~/utils/terminalCopy'

const props = defineProps<{ snapshot: TerminalCopySnapshot, metrics: Record<string, string> }>()
const emit = defineEmits<{ close: [] }>()
const textRoot = ref<HTMLElement | null>(null)
const selected = ref(false)
const result = ref<'idle' | 'copied' | 'failed'>('idle')
const busy = ref(false)
let alive = true
let feedbackTimer: ReturnType<typeof setTimeout> | undefined
// Stable text nodes for the entire copy session, including resize and incoming
// frames. A pre preserves hard newlines in both system Copy and our Copy button.
const segments = props.snapshot.lines.flatMap((line, i) => [
  ...line,
  ...(i < props.snapshot.lines.length - 1 ? [{ text: '\n' }] : []),
])
function selectionChanged() {
  selected.value = !!textRoot.value && !!selectedCopyText(textRoot.value)
  result.value = 'idle'
}
async function copy() {
  const text = textRoot.value && selectedCopyText(textRoot.value)
  if (!text || busy.value) return
  busy.value = true
  const ok = await copyNativeSelection(text, () => alive && !!textRoot.value && selectedCopyText(textRoot.value) === text)
  if (!alive) return
  busy.value = false
  result.value = ok ? 'copied' : 'failed'
  clearTimeout(feedbackTimer)
  if (ok) feedbackTimer = setTimeout(() => { result.value = 'idle' }, 1500)
}
function keydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  e.stopImmediatePropagation()
  emit('close')
}
function systemCopy(e: ClipboardEvent) {
  const text = textRoot.value && selectedCopyText(textRoot.value)
  if (!text || !e.clipboardData) return
  e.preventDefault()
  e.clipboardData.setData('text/plain', text)
}
onMounted(() => {
  document.addEventListener('selectionchange', selectionChanged)
  window.addEventListener('keydown', keydown, true)
  document.addEventListener('copy', systemCopy)
})
onBeforeUnmount(() => {
  alive = false
  clearTimeout(feedbackTimer)
  document.removeEventListener('selectionchange', selectionChanged)
  window.removeEventListener('keydown', keydown, true)
  document.removeEventListener('copy', systemCopy)
  if (textRoot.value && selectedCopyText(textRoot.value)) document.getSelection()?.removeAllRanges()
})
</script>

<template>
  <section class="terminal-copy-layer" :aria-label="t('Copy mode')" @wheel.stop>
    <div class="terminal-copy-scroll">
      <pre ref="textRoot" class="terminal-copy-text" :style="metrics"><span v-for="(span, i) in segments" :key="i" :style="{
        color: span.color, backgroundColor: span.background,
        fontWeight: span.bold ? '600' : undefined, opacity: span.dim ? '.55' : undefined,
        fontStyle: span.italic ? 'italic' : undefined,
        textDecoration: [span.underline && 'underline', span.strike && 'line-through'].filter(Boolean).join(' ') || undefined,
      }">{{ span.text }}</span></pre>
    </div>
    <span v-if="!selected" class="terminal-copy-hint" aria-hidden="true">{{ tl('Hold text to select', 'Appui long pour sélectionner') }}</span>
    <div class="terminal-copy-tools" role="group" :aria-label="t('Copy mode')" @pointerdown.prevent @mousedown.prevent>
      <button type="button" :disabled="!selected || busy" @click="copy"><span>{{ result === 'copied' ? t('Copied') : t('Copy') }}</span></button>
      <button type="button" @click="emit('close')"><span>{{ t('Done') }}</span></button>
    </div>
    <p v-if="result === 'failed'" class="terminal-copy-error" role="alert">{{ tl('Copy failed. Use Copy in the selection menu.', 'Copie impossible. Utilisez Copier dans le menu de sélection.') }}</p>
    <span class="sr-only" role="status" aria-live="polite">{{ result === 'copied' ? t('Copied') : tl('Screen frozen. Long-press text to select.', 'Écran figé. Appuyez longuement sur le texte pour le sélectionner.') }}</span>
  </section>
</template>

<style scoped>
.terminal-copy-layer { position: absolute; inset: 0; z-index: 4; background: var(--bg); color: var(--text); user-select: text; -webkit-user-select: text; -webkit-touch-callout: default; }
.terminal-copy-scroll { position: absolute; inset: 0; overflow: auto; overscroll-behavior: contain; touch-action: pan-x pan-y; }
.terminal-copy-text { margin: 0; padding: 44px 6px 16px; box-sizing: content-box; min-height: calc(100% - 60px); white-space: pre-wrap; word-break: break-all; font-variant-ligatures: none; user-select: text; -webkit-user-select: text; -webkit-touch-callout: default; }
.terminal-copy-tools { position: absolute; top: 0; right: 4px; display: flex; align-items: center; gap: 2px; user-select: none; -webkit-user-select: none; touch-action: manipulation; }
.terminal-copy-hint { position: absolute; top: 0; left: 6px; max-width: calc(100% - 146px); height: 44px; display: flex; align-items: center; color: var(--muted); font: 10px/1.3 var(--mono); user-select: none; -webkit-user-select: none; pointer-events: none; }
.terminal-copy-tools button { display: grid; place-items: center; min-width: 52px; min-height: 44px; padding: 0 2px; color: var(--text); font: 500 11px/1 var(--mono); cursor: pointer; }
.terminal-copy-tools button span { display: grid; place-items: center; min-width: 48px; height: 28px; padding: 0 7px; border: 1px solid var(--line); background: var(--bg); }
.terminal-copy-tools button:last-child span { color: var(--ochre); }
.terminal-copy-tools button:disabled { color: var(--muted); cursor: default; }
.terminal-copy-tools button:active span { background: var(--line-soft); }
.terminal-copy-tools button:focus-visible span { outline: 2px solid var(--ochre); outline-offset: 2px; }
.terminal-copy-error { position: absolute; top: 44px; right: 6px; max-width: min(280px, calc(100% - 12px)); margin: 0; padding: 6px 8px; border: 1px solid var(--rose); background: var(--bg); color: var(--rose); font: 12px/1.4 var(--mono); user-select: none; }
</style>
