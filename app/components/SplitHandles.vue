<script setup lang="ts">
// Handles of wherdr's split tree (computer only): one USplitter per split, nested
// like the tree, laid over the tab's cells. Its panels are empty and let the pointer
// through, so the cells (live terminals) are never moved or remounted: they follow
// `preview` while a handle is dragged, and the tree is written once on release
// (`resize`). Arrows: 5 % steps; double-click: back to 50/50. Each side keeps 15 %.
import type { SplitNode } from '#shared/splitTree'

const props = withDefaults(defineProps<{ node: SplitNode, path?: string }>(), { path: '' })
const emit = defineEmits<{ preview: [path: string, ratio: number | null], resize: [path: string, ratio: number] }>()

const splitter = useTemplateRef<{ $el: HTMLElement, panelsRef: { resize: (size: number) => void }[] }>('splitter')
// defaultSize only counts when the splitter mounts (again on a new direction): changed
// later, Reka lays the panels out afresh from it. A side already under 15 % (a tall stack
// of terminals) is not grown on its own.
const start = ref(props.node.ratio)
watch(() => props.node.dir, () => { start.value = props.node.ratio }, { flush: 'sync' })
const sizes = (r: number) => [r * 100, (1 - r) * 100]
const items = computed(() => {
  const at = sizes(start.value)
  return sizes(props.node.ratio).map((size, i) => ({ defaultSize: at[i], minSize: Math.min(15, size) }))
})
const ui = computed(() => ({ root: 'split-handles', panel: 'split-handles-panel', handle: `split-handle ${props.node.dir} ${props.node.dir === 'right' ? 'w-0' : 'h-0'} focus-visible:outline-none` }))

let dragging = false
let shown = props.node.ratio
function onLayout(layout: number[]) {
  // USplitter keeps the bounds (minSize); not clamped again, to leave a stack's small side be.
  const ratio = Math.round((layout[0] ?? 50) * 10) / 1000
  shown = ratio
  if (syncing) return
  if (dragging) emit('preview', props.path, ratio)
  // Keyboard, double-click: written at once; a layout matching the tree writes nothing.
  else if (Math.abs(ratio - props.node.ratio) >= 0.005) emit('resize', props.path, ratio)
}
function onDragging(_: number, on: boolean) {
  dragging = on
  if (on) return emit('preview', props.path, shown)
  emit('preview', props.path, null)
  if (Math.abs(shown - props.node.ratio) >= 0.005) emit('resize', props.path, shown)
}
const setRatio = (ratio: number) => splitter.value?.panelsRef[0]?.resize(ratio * 100)
// The tree changed elsewhere (another device, a split): the handle follows once the
// panels have their new bounds (post flush: a seventh stacked pane lowers minSize under
// 15 %). Every layout from the new ratio to there (bounds re-evaluated, then the resize)
// is the tree's, never written back as the user's.
let syncing = false
// (Cleared after this update's flush too: a ratio back to its value runs no post watcher.)
watch(() => props.node.ratio, () => {
  syncing = true
  nextTick(() => { syncing = false })
}, { flush: 'sync' })
watch(() => props.node.ratio, (r) => {
  try { if (!dragging && Math.abs(r - shown) >= 0.005) setRatio(r) } finally { syncing = false }
}, { flush: 'post' })

function onDblclick(e: MouseEvent) {
  const handle = (e.target as Element).closest('[data-slot="handle"]')
  if (handle?.parentElement === e.currentTarget && props.node.ratio !== 0.5) setRatio(0.5)
}
// Reka gives the handle its role and values; the line's orientation and name are ours.
function label() {
  for (const h of splitter.value?.$el.querySelectorAll(':scope > [data-slot="handle"]') ?? []) {
    h.setAttribute('aria-orientation', props.node.dir === 'right' ? 'vertical' : 'horizontal')
    h.setAttribute('aria-label', t('Resize'))
    h.setAttribute('title', t('Drag to resize, double-click for 50/50'))
  }
}
onMounted(label)
watch(() => props.node.dir, () => nextTick(label))
</script>

<template>
  <USplitter
    :key="node.dir" ref="splitter" :orientation="node.dir === 'right' ? 'horizontal' : 'vertical'" :items="items"
    :keyboard-resize-by="5" :hit-area-margins="{ coarse: 8, fine: 5 }" :ui="ui"
    @layout="onLayout" @dragging="onDragging" @dblclick="onDblclick"
  >
    <template #panel-0>
      <SplitHandles v-if="typeof node.a !== 'string'" :node="node.a" :path="`${path}0`" @preview="(p, r) => emit('preview', p, r)" @resize="(p, r) => emit('resize', p, r)" />
    </template>
    <template #panel-1>
      <SplitHandles v-if="typeof node.b !== 'string'" :node="node.b" :path="`${path}1`" @preview="(p, r) => emit('preview', p, r)" @resize="(p, r) => emit('resize', p, r)" />
    </template>
  </USplitter>
</template>
