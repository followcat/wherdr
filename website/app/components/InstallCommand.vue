<script setup lang="ts">
// A command (one line, or several joined by newlines) or an agent prompt, copied in one click.
// `big`: a large accent Copy button (the agent prompt card).
const props = withDefaults(defineProps<{ command: string, prompt?: string, what?: string, wrap?: boolean, big?: boolean }>(), {
  prompt: '$',
  what: 'command',
  wrap: false,
  big: false,
})
const text = useTemplateRef<HTMLElement>('text')
const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  try {
    await navigator.clipboard.writeText(props.command)
  } catch {
    // Old browsers / insecure context: select the text instead.
    const sel = window.getSelection()
    const el = text.value
    if (sel && el) { const r = document.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r) }
    return
  }
  copied.value = true
  clearTimeout(timer)
  timer = setTimeout(() => { copied.value = false }, 1800)
}
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="cmd fx-ring halo" :class="{ multiline: wrap, big }">
    <span class="prompt" aria-hidden="true">{{ prompt }}</span>
    <code ref="text" class="text">{{ command }}</code>
    <button type="button" class="copy" :aria-label="copied ? 'Copied' : `Copy the install ${what}`" @click="copy">
      <UIcon :name="copied ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
      <span class="txt">{{ copied ? 'Copied' : 'Copy' }}</span>
    </button>
    <span class="sr-only" aria-live="polite">{{ copied ? `${what[0]!.toUpperCase()}${what.slice(1)} copied to the clipboard` : '' }}</span>
  </div>
</template>

<style scoped>
.cmd {
  display: flex; align-items: stretch; gap: 0;
  font-family: var(--mono); font-size: 14px;
  max-width: 100%;
}
@media (max-width: 420px) {
  .cmd { font-size: 12.5px; }
  .cmd .text { white-space: normal; overflow-wrap: anywhere; }
}
.prompt { display: grid; place-items: center; padding: 0 4px 0 18px; color: var(--green); font-weight: 600; user-select: none; }
.text {
  flex: 1; min-width: 0; padding: 15px 14px 15px 8px;
  color: var(--text); white-space: nowrap; overflow-x: auto; scrollbar-width: none;
}
.text::-webkit-scrollbar { display: none; }
/* Prose prompts and multi-line commands wrap instead of scrolling; the prompt sign stays on the first line. */
.multiline .text { white-space: pre-wrap; overflow-wrap: break-word; line-height: 1.6; }
.multiline .prompt { place-items: start center; padding-top: 15px; line-height: 1.6; }
.copy {
  display: inline-flex; align-items: center; gap: 8px; flex: none;
  padding: 0 18px; border: 0; border-left: 1px solid var(--line);
  background: transparent; color: var(--muted); cursor: pointer;
  font: 600 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase;
  transition: color .15s, background .15s;
}
.copy:hover { color: var(--text); background: var(--surface); }
@media (max-width: 520px) {
  .cmd { font-size: 13px; }
  .copy .txt { display: none; }
  .copy { padding: 0 14px; }
}
/* The agent prompt: a large Copy button in the accent colour, always labelled. */
.big .copy { margin: 10px; padding: 0 26px; border: 0; background: var(--accent); color: var(--bg); font-size: 13px; }
.big .copy:hover { background: color-mix(in srgb, var(--accent) 85%, #fff); color: var(--bg); }
@media (max-width: 520px) {
  .big { flex-wrap: wrap; }
  .big .text { flex-basis: calc(100% - 40px); }
  .big .copy { flex: 1 1 calc(100% - 20px); justify-content: center; margin: 0 10px 10px; padding: 14px; }
  .big .copy .txt { display: inline; }
}
</style>
