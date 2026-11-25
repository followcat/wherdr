<script setup lang="ts">
// A folder tree on Nuxt UI's UTree. `load(key)` lists a folder's children the
// first time it is expanded ('' is the tree's top), with a loading row, then an
// error, empty or note row when there is nothing to list. Rows stay flat
// (`nested: false`) with our own guide lines, so a big tree looks the same once
// it is virtualized.
import type { TreeItem } from '@nuxt/ui'

export interface TreeNode { key: string, label: string, icon?: string, tone?: string, branch?: boolean, note?: 'loading' | 'error' | 'empty' | 'info', [extra: string]: unknown }
const props = defineProps<{ load: (key: string) => Promise<TreeNode[]>, empty: string, show?: (node: TreeNode, parent: string) => boolean }>()
const emit = defineEmits<{ pick: [node: TreeNode] }>()
const expanded = defineModel<string[]>('expanded', { default: () => [] })
const selected = defineModel<string | null>('selected', { default: null })

// A key without a state is loading.
const states = ref<Record<string, { nodes?: TreeNode[], error?: string }>>({})
const asked = new Map<string, Promise<void>>()
let generation = 0
function ensure(key: string) {
  let p = asked.get(key)
  if (!p) {
    const g = generation
    p = props.load(key).then(
      (nodes) => { if (g === generation) states.value[key] = { nodes } },
      (e) => { if (g === generation) states.value[key] = { error: (e as Error).message } },
    )
    asked.set(key, p)
  }
  return p
}
watch(expanded, (keys) => { ensure(''); keys.forEach(ensure) }, { immediate: true })
// Everything read again; a collapsed folder is read when it opens again.
function reload() {
  generation++
  asked.clear()
  for (const k of Object.keys(states.value)) if (k && !expanded.value.includes(k)) delete states.value[k]
  return Promise.all(['', ...expanded.value].map(ensure))
}

const asNote = (n: TreeNode): TreeItem => ({ ...n, disabled: true, class: `tree-note tree-${n.note}` })
const note = (parent: string, kind: NonNullable<TreeNode['note']>, label: string) => asNote({ key: `${parent}\n${kind}`, label, note: kind })
function kids(key: string): TreeItem[] {
  const s = states.value[key]
  if (!s) return [note(key, 'loading', t('Loading…'))]
  if (s.error !== undefined) return [note(key, 'error', s.error)]
  const nodes = s.nodes!.filter(n => n.note || !props.show || props.show(n, key))
  return nodes.length ? nodes.map(item) : [note(key, 'empty', props.empty)]
}
function item(n: TreeNode): TreeItem {
  if (n.note) return asNote(n)
  return { ...n, children: n.branch ? (expanded.value.includes(n.key) ? kids(n.key) : []) : undefined }
}
const items = computed(() => kids(''))
// Rows in display order: past 200, only the visible ones are drawn.
const flat = computed(() => {
  const keys: string[] = []
  const walk = (xs: TreeItem[]) => xs.forEach((x) => { keys.push(x.key); if (x.children) walk(x.children) })
  walk(items.value)
  return keys
})
const coarse = import.meta.client && window.matchMedia?.('(pointer: coarse)').matches
const rowHeight = coarse ? 44 : 30
const virtual = computed(() => flat.value.length > 200 ? { estimateSize: rowHeight, overscan: 12 } : false)
const current = computed(() => selected.value === null ? undefined : { key: selected.value })

let revealing = 0
function pick(i: TreeItem) {
  if (i.note) return
  revealing++
  selected.value = i.key
  emit('pick', i as TreeNode)
}
const tree = useTemplateRef<{ $el: HTMLElement }>('tree')
// Opens these folders (parents first), then selects and shows `select`;
// a later reveal or pick wins.
async function reveal(keys: string[], select?: string) {
  const id = ++revealing
  expanded.value = [...new Set([...expanded.value, ...keys])]
  await Promise.all(keys.map(ensure))
  if (id !== revealing) return
  if (select !== undefined) selected.value = select
  const key = select ?? keys.at(-1)
  await nextTick()
  const el = tree.value?.$el
  if (!el || key === undefined) return
  const row = el.querySelector(`[data-tree-key="${CSS.escape(key)}"]`)?.closest('button')
  if (row) row.scrollIntoView({ block: 'nearest' })
  else if (flat.value.includes(key)) el.scrollTop = flat.value.indexOf(key) * rowHeight
}
defineExpose({ reveal, reload })
</script>

<template>
  <UTree
    ref="tree" :items="items" :get-key="(i: TreeItem) => i.key" :nested="false" :virtualize="virtual"
    :expanded="expanded" :model-value="current" color="neutral" class="folder-tree" :ui="{ link: 'tree-row' }"
    @update:expanded="expanded = $event" @select="(_e: unknown, i: TreeItem) => pick(i)"
  >
    <template #item-leading="{ item: i, level, expanded: open }">
      <span class="tree-indent" :style="{ '--level': level - 1 }" :data-tree-key="i.key" />
      <UIcon :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="tree-chevron" :class="{ invisible: !i.branch }" />
      <span v-if="i.note === 'loading'" class="spinner" />
      <UIcon v-else-if="i.note === 'error'" name="i-lucide-circle-alert" class="tree-icon error" />
      <UIcon v-else-if="i.note === 'info'" name="i-lucide-shield-alert" class="tree-icon info" />
      <UIcon v-else-if="!i.note" :name="i.icon || 'i-lucide-folder'" class="tree-icon" :class="i.tone" />
    </template>
    <!-- Always an element: an empty slot would bring back UTree's chevron. -->
    <template #item-trailing="{ item: i }"><span class="tree-trailing"><slot name="trailing" :node="i as TreeNode" /></span></template>
  </UTree>
</template>
