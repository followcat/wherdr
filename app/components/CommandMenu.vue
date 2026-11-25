<script setup lang="ts">
// The ⌘K palette (also the home magnifier): conversations, tasks, projects,
// settings and actions in one searchable list (UCommandPalette). Conversations
// are searched on the server as the user types (/api/search), grouped by agent
// under an agent-card-style header; the rest is filtered here. Empty query:
// the recent conversations and the main actions. Full screen on the phone,
// square window on a computer; ↑/↓ and Enter on the keyboard.
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import type { ConversationHit, ConversationSearchResponse, Pane } from '#shared/types'
import type { Board } from '#shared/pm/board'
import { machineOf } from '#shared/ids'
import { highlightParts } from '#shared/searchText'
import { SETTINGS_SECTIONS } from '#shared/appLinks'
import { UI_TARGETS, projectTarget, uiTargetLink, uiTargetName, type UiTargetId } from '#shared/uiTargets'
import { settingsSectionIcons, settingsSectionLabels } from '~/utils/settingsNav'
import { shortcutKbds, shortcutsOpen } from '~/composables/useShortcuts'

type Item = CommandPaletteItem & { id: string, pane?: Pane, hit?: ConversationHit }

const open = defineModel<boolean>('open', { default: false })
const query = ref('')
const hits = ref<ConversationHit[]>([])
const limited = ref(false)
const busy = ref(false)
const error = ref('')
const board = ref<Board | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
let sequence = 0

const space = (p: Pane) => herdrState.value.workspaces.find(w => w.id === p.workspace)
const paneTitle = (p: Pane) => paneTaskTitle(p) || homeTitle(p, space(p))
const roleLabel = (hit: ConversationHit) => (hit.role === 'user' ? t('You') : kindLabel(hit.agent))
const agentItem = (p: Pane): Item => ({ id: `agent:${p.id}`, label: paneTitle(p), slot: 'agent', pane: p, onSelect: () => go(`/a/${encodeURIComponent(p.id)}`) })

const recent = computed(() => herdrState.value.panes.filter(p => p.agent).sort((a, b) => (b.since ?? 0) - (a.since ?? 0) || (b.stateSeq ?? 0) - (a.stateSeq ?? 0)).slice(0, 6))
const agentMatches = computed(() => {
  const q = query.value.trim().toLocaleLowerCase()
  if (q.length < 2) return []
  return herdrState.value.panes.filter(p => p.agent && [paneTaskTitle(p), homeTitle(p, space(p)), spaceTitle(p, space(p)), conversationSubtitle(p, space(p)), kindLabel(p.agent), p.name || ''].some(s => s.toLocaleLowerCase().includes(q))).slice(0, 12)
})
// One group per agent: its header (agent card style), then its hits.
const hitGroups = computed(() => {
  const map = new Map<string, ConversationHit[]>()
  for (const hit of hits.value) map.set(hit.pane, [...(map.get(hit.pane) ?? []), hit])
  return [...map.entries()].map(([id, items]) => {
    const pane = herdrState.value.panes.find(p => p.id === id)
    const key = machineOf(id)
    return {
      id: `hits:${id}`, slot: 'hit', ignoreFilter: true, label: pane ? paneTitle(pane) : items[0]!.title,
      agent: items[0]!.agent || pane?.agent, pane, count: items.length,
      subtitle: pane ? conversationSubtitle(pane, space(pane)) : '',
      machine: multiMachine.value ? machineName(key) : '',
      machineIcon: machineInfo(key)?.local ? 'i-lucide-server' : 'i-lucide-laptop',
      items: items.map((hit): Item => ({ id: `hit:${hit.pane}:${hit.offset}:${hit.text}`, label: hit.excerpt, hit, onSelect: () => choose(hit) })),
    }
  })
})

const actions = computed<Item[]>(() => [
  { id: 'new-agent', label: tl('New agent'), icon: 'i-lucide-plus', kbds: shortcutKbds('new-space'), onSelect: () => { close(); newAgentOpen.value = true } },
  { id: 'new-task', label: tl('New task'), icon: 'i-lucide-list-plus', onSelect: () => go('/board?add=1') },
  { id: 'review', label: tl('Tasks to review'), icon: 'i-lucide-list-checks', onSelect: () => { close(); showReview() } },
  { id: 'notes', label: tl('Notes'), icon: 'i-lucide-notebook-pen', kbds: shortcutKbds('notes'), onSelect: () => { close(); openNotes() } },
  { id: 'shortcuts', label: tl('Keyboard shortcuts'), icon: 'i-lucide-keyboard', kbds: shortcutKbds('help'), onSelect: () => { close(); shortcutsOpen.value = true } },
])
const targetIds = Object.keys(UI_TARGETS) as UiTargetId[]
const settings = computed<Item[]>(() => [
  ...SETTINGS_SECTIONS.filter(s => s !== 'shortcuts' || desk.value).map(s => ({ id: `section:${s}`, label: t(settingsSectionLabels[s]), icon: settingsSectionIcons[s], onSelect: () => go(`/settings?section=${s}`) })),
  ...targetIds.filter(id => !projectTarget(id)).map(id => ({ id: `target:${id}`, label: UI_TARGETS[id].label, icon: settingsSectionIcons[id.split('.')[0] as keyof typeof settingsSectionIcons], onSelect: () => go(uiTargetLink(id).slice(1)) })),
  // A project's settings, once per loaded project: "Demo app › Workflow".
  ...(board.value?.projects ?? []).flatMap(p => targetIds.filter(projectTarget).map(id => ({ id: `target:${id}:${p.key}`, label: `${p.name} › ${uiTargetName(id)}`, suffix: p.label || p.key, icon: settingsSectionIcons.projects, onSelect: () => go(uiTargetLink(id, p.key).slice(1)) }))),
])
const groups = computed<CommandPaletteGroup[]>(() => {
  if (!query.value.trim()) return [{ id: 'recent', label: tl('Recent conversations'), ignoreFilter: true, items: recent.value.map(agentItem) }, { id: 'actions', label: tl('Actions'), ignoreFilter: true, items: actions.value }]
  return [
    { id: 'conversations', label: tl('Conversations'), ignoreFilter: true, items: agentMatches.value.map(agentItem) },
    { id: 'tasks', label: tl('Tasks'), items: (board.value?.cards ?? []).map(c => ({ id: `task:${c.id}`, label: c.title, suffix: c.shown, icon: 'i-lucide-square-check', onSelect: () => { close(); openTaskSheet(c.id) } })) },
    { id: 'projects', label: tl('Projects'), items: (board.value?.projects ?? []).map(p => ({ id: `project:${p.key}`, label: p.name, suffix: p.label || p.key, icon: 'i-lucide-kanban', onSelect: () => go(coordinatorBoardPath(p.key)) })) },
    { id: 'settings', label: t('Settings'), items: settings.value },
    // The messages last but the actions: the short groups above stay in sight.
    ...hitGroups.value,
    { id: 'actions', label: tl('Actions'), items: actions.value },
  ]
})

async function run() {
  controller?.abort()
  const q = query.value.trim()
  const n = ++sequence
  controller = new AbortController()
  busy.value = true
  error.value = ''
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
    if (!r.ok) throw new Error(t('Search unavailable'))
    const data = await r.json() as ConversationSearchResponse
    if (n !== sequence) return
    hits.value = data.hits
    limited.value = data.limited
  } catch (e) {
    if (n === sequence && (e as Error).name !== 'AbortError') { error.value = (e as Error).message; hits.value = [] }
  } finally { if (n === sequence) busy.value = false }
}
watch(query, () => {
  clearTimeout(timer)
  controller?.abort()
  ++sequence
  if (query.value.trim().length < 2) { hits.value = []; busy.value = false; limited.value = false; return }
  timer = setTimeout(run, 280)
})
watch(open, (v) => {
  if (v) api<Board>('/api/pm/board').then((b) => { board.value = b }, () => {})
  else { clearTimeout(timer); controller?.abort(); ++sequence; query.value = ''; hits.value = [] }
}, { immediate: true })
onUnmounted(() => { clearTimeout(timer); controller?.abort() })
function close() { open.value = false }
async function go(path: string) { close(); await navigateTo(path) }
async function choose(hit: ConversationHit) {
  const q = query.value
  close()
  await navigateTo({ path: `/a/${encodeURIComponent(hit.pane)}`, query: { q, hit: String(hit.offset), ts: hit.ts || '', role: hit.role, prefix: hit.text } })
}
const paletteUi = {
  root: 'flex-1 divide-y-0', input: 'global-search-input', content: 'flex-1 min-h-0', viewport: 'global-search-list divide-y-0',
  group: 'palette-group', label: 'palette-label', item: 'palette-item', empty: 'global-search-note', itemLabelBase: 'palette-mark', itemLabelSuffix: 'palette-suffix palette-mark',
}
</script>

<template>
  <div v-if="open" class="global-search-backdrop" @click.self="close" @keydown.esc.stop.prevent="close">
    <section class="global-search" role="dialog" aria-modal="true" :aria-label="tl('Search conversations, tasks, settings and actions')">
      <header class="global-search-head">
        <div class="eyebrow"><span>{{ tl('Search and actions') }}</span></div>
        <button type="button" class="global-search-cancel mono-btn" @click="close">{{ desk ? t('Esc') : t('Cancel') }}</button>
      </header>
      <UCommandPalette
        v-model:search-term="query" :groups="groups" preserve-group-order :loading="busy" :fuse="{ resultLimit: 20 }"
        :placeholder="tl('Search conversations, tasks, settings…')" :ui="paletteUi"
      >
        <template #agent="{ item }">
          <AgentAvatar :agent="item.pane.agent" />
          <span class="global-search-agent-main"><span class="global-search-agent-title">{{ item.label }}</span><span class="global-search-agent-meta"><StatusPill :pane="item.pane" kind /><span v-if="conversationSubtitle(item.pane, space(item.pane))">{{ conversationSubtitle(item.pane, space(item.pane)) }}</span></span></span>
          <UIcon name="i-lucide-arrow-up-right" />
        </template>
        <template #hit-group-label="{ group: g }">
          <div v-for="group in hitGroups.filter(h => h.id === g.id)" :key="group.id" class="global-search-agent">
            <AgentAvatar :agent="group.agent" />
            <div class="global-search-agent-main">
              <div class="global-search-agent-title">{{ group.label }}</div>
              <div class="global-search-agent-meta">
                <StatusPill :pane="group.pane" />
                <span v-if="group.subtitle">{{ group.subtitle }}</span>
                <span v-if="group.machine" class="global-search-machine"><UIcon :name="group.machineIcon" />{{ group.machine }}</span>
              </div>
            </div>
            <span class="global-search-count">{{ group.count }}</span>
          </div>
        </template>
        <template #hit="{ item }">
          <span class="global-search-hit" :class="{ stale: busy }">
            <span class="global-search-excerpt"><template v-for="(part, i) in highlightParts(item.hit.excerpt, query)" :key="i"><mark v-if="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
            <span class="global-search-meta">
              <span :class="['global-search-role', item.hit.role === 'user' ? 'user' : item.hit.agent]">{{ roleLabel(item.hit) }}</span>
              <template v-if="item.hit.ts"><span class="sep">·</span><time :datetime="item.hit.ts">{{ fmtWhen(item.hit.ts) }}</time></template>
            </span>
          </span>
        </template>
        <template #empty>
          <span v-if="busy"><i class="global-search-pulse" />{{ t('Searching…') }}</span>
          <span v-else-if="error" class="bad">{{ error }}</span>
          <span v-else>{{ t('No results') }}</span>
        </template>
        <template #footer>
          <p v-if="limited && !busy" class="global-search-foot">{{ t('Results limited. Refine your search.') }}</p>
          <div v-if="desk" class="global-search-keys">
            <span><kbd>↑</kbd><kbd>↓</kbd>{{ t('navigate') }}</span>
            <span><kbd>↵</kbd>{{ t('open') }}</span>
            <span><kbd>esc</kbd>{{ t('close') }}</span>
          </div>
        </template>
      </UCommandPalette>
    </section>
  </div>
</template>
