<script setup lang="ts">
// Left edge of the side panel beside the conversation (computer ≥ 1280 px):
// drag or arrow keys to resize, double-click (or Home / Enter) for the default
// width. Clamped (utils/sideWidth.ts) and kept on the device. It sets
// --settings-panel, which the panel and the conversation follow.
import { PANEL_MIN, clampPanelWidth, panelWidthCss, readPanelWidth, savePanelWidth } from '~/utils/sideWidth'

// controls: the panel's id (Settings, or Notes).
const props = withDefaults(defineProps<{ controls?: string }>(), { controls: 'settings' })

const width = ref<number | null>(null)
const dragging = ref(false)
const shown = ref(0)

function panelNow() { return document.getElementById(props.controls)?.getBoundingClientRect().width || 480 }
function listRight() { return document.getElementById('home')?.getBoundingClientRect().right || 0 }
const clamp = (w: number) => clampPanelWidth(w, window.innerWidth, listRight())

function apply(w: number | null) {
  const root = document.documentElement.style
  if (w === null) root.removeProperty('--settings-panel')
  else root.setProperty('--settings-panel', panelWidthCss(w))
  nextTick(() => { shown.value = Math.round(panelNow()) })
}
watch(width, apply)
onMounted(() => {
  width.value = readPanelWidth()
  apply(width.value)
})
onUnmounted(() => document.documentElement.style.removeProperty('--settings-panel'))

function onGrab(e: PointerEvent) {
  if (e.button !== 0) return
  const handle = e.currentTarget as HTMLElement
  e.preventDefault()
  const x0 = e.clientX
  const w0 = panelNow()
  handle.setPointerCapture?.(e.pointerId)
  dragging.value = true
  // The handle is the panel's left edge: moving left widens it.
  const move = (ev: PointerEvent) => { width.value = clamp(w0 - (ev.clientX - x0)) }
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    dragging.value = false
    savePanelWidth(width.value)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); return reset() }
  const step = e.shiftKey ? 64 : 16
  const d = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0
  if (!d) return
  e.preventDefault()
  width.value = clamp(panelNow() + d)
  savePanelWidth(width.value)
}
function reset() {
  width.value = null
  savePanelWidth(null)
}
</script>

<template>
  <Teleport to="body">
    <div
      class="panel-handle" :class="{ dragging }" role="separator" aria-orientation="vertical" tabindex="0"
      :aria-controls="controls" :aria-label="t('Panel width')" :aria-valuenow="shown || undefined" :aria-valuemin="PANEL_MIN"
      :title="t('Drag to resize · double-click: default width')"
      @pointerdown="onGrab" @dblclick="reset" @keydown="onKey"
    />
  </Teleport>
</template>
