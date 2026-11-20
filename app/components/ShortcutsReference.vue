<script setup lang="ts">
// Shared keyboard shortcut reference: those of the table
// (utils/shortcuts.ts) and those a component owns, grouped by place.
// `editable` (Settings › Shortcuts): Change / Reset per row of the table.
import { type ShortcutId, FIXED_SHORTCUTS, bindingFromEvent, bindingKbds, findConflict, reservedReason, sameKeys, tableKbds, SHORTCUTS } from '~/utils/shortcuts'
import { activeShortcuts, shortcutBindings, shortcutKbds, shortcutRecording } from '~/composables/useShortcuts'

const props = defineProps<{ editable?: boolean }>()
const mac = /Macintosh|Mac OS X|iPhone|iPad/.test(navigator.userAgent)
const ARROWS = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown']
type Row = { label: string, keys: string[][], id?: ShortcutId, v2?: true }
type Group = { title: string, rows: Row[] }
// herdr-core (v3): the rows marked v2 (tabs, swap) are not offered yet.
const allGroups = computed<Group[]>(() => [
  { title: tl('Anywhere'), rows: [
    { id: 'search-all', label: tl('Search agents and conversations'), keys: [shortcutKbds('search-all')] },
    { id: 'prev-agent', label: tl('Previous agent in the list'), keys: [shortcutKbds('prev-agent')] },
    { id: 'next-agent', label: tl('Next agent in the list'), keys: [shortcutKbds('next-agent')] },
    { id: 'prev-tab', label: tl('Previous tab of this space'), keys: [shortcutKbds('prev-tab')] },
    { id: 'next-tab', label: tl('Next tab of this space'), keys: [shortcutKbds('next-tab')] },
    { id: 'new-space', label: tl('New agent, in a new space'), keys: [shortcutKbds('new-space')] },
    { id: 'new-tab', label: tl('New tab in this space'), keys: [shortcutKbds('new-tab')], v2: true },
    { id: 'close-pane', label: tl('Close this pane'), keys: [shortcutKbds('close-pane')] },
    { id: 'split-right', label: tl('Split this pane right (new shell)'), keys: [shortcutKbds('split-right')] },
    { id: 'split-down', label: tl('Split this pane down (new shell)'), keys: [shortcutKbds('split-down')] },
    { id: 'open-editor', label: tl('Current agent folder in the editor'), keys: [shortcutKbds('open-editor')] },
    { id: 'settings', label: t('Settings'), keys: [shortcutKbds('settings')] },
    { id: 'notes', label: tl('Notes'), keys: [shortcutKbds('notes')] },
    { id: 'help', label: tl('Keyboard shortcuts'), keys: [shortcutKbds('help'), ['?']] },
  ] },
  { title: tl('Agent'), rows: [
    { id: 'search-chat', label: tl('Search this conversation'), keys: [shortcutKbds('search-chat')] },
    { id: 'toggle-term', label: tl('Conversation / terminal'), keys: [shortcutKbds('toggle-term')] },
    { id: 'stop', label: tl('Stop the agent (twice, empty field)'), keys: [[...shortcutKbds('stop'), ...shortcutKbds('stop')]] },
    { label: tl('Send / new line'), keys: [['enter'], ['shift', 'enter']] },
    { label: tl('Previous / next sent text (first / last line)'), keys: [['arrowup'], ['arrowdown']] },
    { label: tl('Use Claude’s suggestion'), keys: [['tab']] },
  ] },
  { title: tl('Side by side'), rows: [
    { label: tl('Focus the neighbouring pane'), keys: [['meta', 'alt', ...ARROWS]] },
    { label: tl('Swap with the neighbouring pane'), keys: [['alt', 'shift', ...ARROWS]], v2: true },
  ] },
  { title: tl('“Your turn” card'), rows: [
    { label: tl('Choose an option'), keys: [['1–9']] },
    { label: tl('Move, confirm, cancel'), keys: [['arrowup', 'arrowdown', 'enter', 'escape']] },
  ] },
  { title: tl('Terminal'), rows: [
    { label: tl('Copy the selection'), keys: [mac ? ['meta', 'C'] : ['ctrl', 'shift', 'C']] },
    { label: tl('New line for the agent'), keys: [['shift', 'enter']] },
  ] },
])
const groups = computed(() => allGroups.value.map(g => ({ ...g, rows: g.rows.filter(r => !r.v2) })))
const labelOf = (id: ShortcutId) => allGroups.value.flatMap(g => g.rows).find(r => r.id === id)?.label ?? id
const changeable = (r: Row) => Boolean(r.id && !FIXED_SHORTCUTS.includes(r.id))

const recording = ref<ShortcutId | null>(null)
const problem = ref('')
function stop() {
  recording.value = null
  problem.value = ''
  shortcutRecording.value = false
  window.removeEventListener('keydown', onKey, true)
}
function start(id: ShortcutId) {
  stop()
  recording.value = id
  shortcutRecording.value = true
  window.addEventListener('keydown', onKey, true)
}
function onKey(e: KeyboardEvent) {
  const id = recording.value
  if (!id) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') return stop()
  const b = bindingFromEvent(e, mac)
  if (!b) return
  const reason = reservedReason(b)
  if (reason) {
    problem.value = reason === 'browser' ? tl('Reserved by the browser: choose other keys.') : tl('Add Ctrl, Alt or ⌘.')
    return
  }
  const other = findConflict(activeShortcuts.value, id, bindingKbds(b), mac)
  if (other) {
    problem.value = tl(`Already used by “${labelOf(other)}”: change that one first.`)
    return
  }
  const next = { ...shortcutBindings.value, [id]: b }
  // The default keys again: no override kept.
  if (sameKeys(defaultKbds(id), bindingKbds(b), mac)) delete next[id]
  shortcutBindings.value = next
  stop()
}
function reset(id: ShortcutId) {
  const { [id]: _, ...rest } = shortcutBindings.value
  shortcutBindings.value = rest
}
const custom = computed(() => Object.keys(shortcutBindings.value).length > 0)
const isCustom = (id?: ShortcutId) => Boolean(id && shortcutBindings.value[id])
const defaultKbds = (id: ShortcutId) => tableKbds(SHORTCUTS, id)
onBeforeUnmount(stop)
</script>

<template>
  <div class="shortcuts-reference">
    <div v-if="props.editable && custom" class="shortcuts-reset-all">
      <UButton color="neutral" variant="outline" size="sm" class="mono-btn" icon="i-lucide-rotate-ccw" @click="stop(); shortcutBindings = {}">
        {{ tl('Reset all') }}
      </UButton>
    </div>
    <section v-for="g in groups" :key="g.title" class="settings-group shortcuts-group">
      <h3>{{ g.title }}</h3>
      <dl>
        <div v-for="r in g.rows" :key="r.label" class="shortcut-row" :class="{ recording: props.editable && r.id && recording === r.id }">
          <dt>
            {{ r.label }}
            <small v-if="props.editable && recording && recording === r.id" class="shortcut-note" :class="{ warn: problem }" role="status">{{ problem || tl('Press the new keys (Escape to cancel)') }}</small>
            <small v-else-if="props.editable && !changeable(r)" class="shortcut-note">{{ r.id === 'stop' ? tl('Reserved: Escape belongs to the agent and windows') : tl('Reserved') }}</small>
            <small v-else-if="props.editable && isCustom(r.id)" class="shortcut-note">{{ tl('Default:') }} <UKbd v-for="k in defaultKbds(r.id!)" :key="k" :value="k" size="sm" /></small>
          </dt>
          <dd>
            <template v-for="(combo, i) in r.keys" :key="i">
              <span v-if="i" class="sep">/</span>
              <UKbd v-for="k in combo" :key="k" :value="k" />
            </template>
            <template v-if="props.editable && changeable(r)">
              <UButton v-if="recording === r.id" color="neutral" variant="ghost" size="sm" class="mono-btn shortcut-btn" @click="stop">{{ t('Cancel') }}</UButton>
              <UButton v-else color="neutral" variant="outline" size="sm" class="mono-btn shortcut-btn" @click="start(r.id!)">{{ tl('Change') }}</UButton>
              <UButton v-if="isCustom(r.id)" color="neutral" variant="ghost" size="sm" class="mono-btn shortcut-btn" @click="reset(r.id!)">{{ tl('Reset') }}</UButton>
            </template>
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>
