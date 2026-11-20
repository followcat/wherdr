<script setup lang="ts">
// Dividers of a tab's split tree (side by side, computer only), over the cells of
// their parent. Dragged: `preview` on each move (the cells follow, each terminal fits
// its cell), `resize` once on release; double-click: back to 50/50; arrows: 5 % steps.
// Ratios stay between 0.15 and 0.85 (clampRatio).
import { type Divider, clampRatio } from '#shared/splitTree'

defineProps<{ dividers: Divider[] }>()
const emit = defineEmits<{ preview: [path: string, ratio: number | null], resize: [path: string, ratio: number] }>()

const on = ref<string | null>(null)
let drag: { d: Divider, pointer: number, ratio: number, area: DOMRect } | null = null

const style = (d: Divider) => (d.direction === 'right'
  ? { left: `${d.at}%`, top: `${d.from}%`, height: `${d.span}%` }
  : { top: `${d.at}%`, left: `${d.from}%`, width: `${d.span}%` })

function down(d: Divider, e: PointerEvent) {
  const area = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect()
  if (e.button !== 0 || !area) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  drag = { d, pointer: e.pointerId, ratio: d.ratio, area }
  on.value = d.path
}
function move(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointer) return
  const { d, area } = drag
  const at = d.direction === 'right'
    ? (area.width ? ((e.clientX - area.left) / area.width) * 100 : d.at)
    : (area.height ? ((e.clientY - area.top) / area.height) * 100 : d.at)
  drag.ratio = d.size > 0 ? clampRatio((at - d.start) / d.size) : d.ratio
  emit('preview', d.path, drag.ratio)
}
function up(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointer) return
  const { d, ratio } = drag
  stop()
  if (Math.abs(ratio - d.ratio) >= 0.005) emit('resize', d.path, ratio)
}
function stop() {
  if (drag) emit('preview', drag.d.path, null)
  drag = null
  on.value = null
}
function key(d: Divider, e: KeyboardEvent) {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key]
  if (!step || (d.direction === 'right') !== (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
  e.preventDefault()
  const ratio = clampRatio(d.ratio + step * 0.05)
  if (ratio !== d.ratio) emit('resize', d.path, ratio)
}
function reset(d: Divider) {
  if (d.ratio !== 0.5) emit('resize', d.path, 0.5)
}
</script>

<template>
  <div
    v-for="d in dividers" :key="d.path" class="divider" :class="[d.direction, { on: on === d.path }]" :style="style(d)"
    role="separator" tabindex="0" :aria-orientation="d.direction === 'right' ? 'vertical' : 'horizontal'"
    :aria-label="t('Resize')" :title="t('Drag to resize, double-click for 50/50')"
    :aria-valuenow="Math.round(d.ratio * 100)" aria-valuemin="15" aria-valuemax="85"
    @pointerdown="down(d, $event)" @pointermove="move" @pointerup="up" @pointercancel="stop"
    @dblclick="reset(d)" @keydown="key(d, $event)"
  />
</template>
