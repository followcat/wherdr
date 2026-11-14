<script setup lang="ts">
// Search across all conversations (home magnifier, ⌘K): full
// screen on the phone, square window on a computer. Results grouped by
// agent (agent-card-style header), ↑/↓ and Enter on the keyboard.
import type { ConversationHit, ConversationSearchResponse, Pane } from '#shared/types'
import { machineOf } from '#shared/ids'
import { highlightParts } from '#shared/searchText'

const open = defineModel<boolean>('open', { default: false })
const query = ref('')
const hits = ref<ConversationHit[]>([])
const limited = ref(false)
const busy = ref(false)
const error = ref('')
const active = ref(0)
const agentMatches = computed(() => {
  const q = query.value.trim().toLocaleLowerCase()
  if (q.length < 2) return []
  return herdrState.value.panes.filter(p => p.agent && [paneTaskTitle(p), homeTitle(p, herdrState.value.workspaces.find(w => w.id === p.workspace)), spaceTitle(p, herdrState.value.workspaces.find(w => w.id === p.workspace)), conversationSubtitle(p, herdrState.value.workspaces.find(w => w.id === p.workspace)), kindLabel(p.agent), p.name || ''].some(s => s.toLocaleLowerCase().includes(q))).slice(0, 12)
})
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
let sequence = 0
// Options in order: agents, then conversation hits.
const hitBase = computed(() => agentMatches.value.length)
const count = computed(() => hitBase.value + hits.value.length)
const groups = computed(() => {
  const map = new Map<string, { hit: ConversationHit, index: number }[]>()
  hits.value.forEach((hit, index) => {
    if (!map.has(hit.pane)) map.set(hit.pane, [])
    map.get(hit.pane)!.push({ hit, index })
  })
  return [...map.entries()].map(([id, items]) => {
    const first = items[0]!.hit
    const pane = herdrState.value.panes.find(p => p.id === id)
    const key = machineOf(id)
    return {
      id, items, agent: first.agent || pane?.agent, pane,
      title: pane ? paneTaskTitle(pane) || homeTitle(pane, herdrState.value.workspaces.find(w => w.id === pane.workspace)) : first.title,
      subtitle: pane ? conversationSubtitle(pane, herdrState.value.workspaces.find(w => w.id === pane.workspace)) : '',
      machine: multiMachine.value ? machineName(key) : '',
      machineIcon: machineInfo(key)?.local ? 'i-lucide-server' : 'i-lucide-laptop',
    }
  })
})
const hitId = (i: number) => `global-search-hit-${i}`
const roleLabel = (hit: ConversationHit) => (hit.role === 'user' ? t('You') : kindLabel(hit.agent))
async function run() {
  controller?.abort()
  const q = query.value.trim()
  const n = ++sequence
  if (q.length < 2) { hits.value = []; busy.value = false; limited.value = false; return }
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
    active.value = 0
    list.value?.scrollTo({ top: 0 })
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
  if (v) nextTick(() => input.value?.focus())
  else { clearTimeout(timer); controller?.abort(); ++sequence; query.value = ''; hits.value = []; active.value = 0 }
})
onUnmounted(() => { clearTimeout(timer); controller?.abort() })
function close() { open.value = false }
function clearQuery() { query.value = ''; nextTick(() => input.value?.focus()) }
function move(step: number) {
  if (!count.value) return
  active.value = (active.value + step + count.value) % count.value
  nextTick(() => document.getElementById(hitId(active.value))?.scrollIntoView({ block: 'nearest' }))
}
function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') {
    const pane = agentMatches.value[active.value]
    const hit = !busy.value ? hits.value[active.value - hitBase.value] : undefined
    if (pane) { e.preventDefault(); chooseAgent(pane) }
    else if (hit) { e.preventDefault(); choose(hit) }
    else input.value?.blur()
  }
}
async function chooseAgent(p: Pane) {
  open.value = false
  await navigateTo(`/a/${encodeURIComponent(p.id)}`)
}
async function choose(hit: ConversationHit) {
  const q = query.value
  open.value = false
  await navigateTo({ path: `/a/${encodeURIComponent(hit.pane)}`, query: { q, hit: String(hit.offset), ts: hit.ts || '', role: hit.role, prefix: hit.text } })
}
</script>

<template>
  <div v-if="open" class="global-search-backdrop" @click.self="close" @keydown.esc.stop.prevent="close">
    <section class="global-search" role="dialog" aria-modal="true" :aria-label="tl('Search agents and conversations', 'Rechercher agents et conversations')">
      <header class="global-search-head">
        <div class="eyebrow"><span>{{ tl('Agents and conversations', 'Agents et conversations') }}</span></div>
        <button type="button" class="global-search-cancel mono-btn" @click="close">{{ desk ? t('Esc') : t('Cancel') }}</button>
      </header>
      <div class="global-search-input">
        <UIcon name="i-lucide-search" />
        <input
          ref="input" v-model="query" type="text" role="combobox" inputmode="search" enterkeyhint="search"
          aria-autocomplete="list" aria-controls="global-search-results" :aria-expanded="count > 0"
          :aria-activedescendant="count ? hitId(active) : undefined"
          :aria-label="tl('Search agents and conversations', 'Rechercher agents et conversations')" :placeholder="tl('Search agents and conversations', 'Rechercher agents et conversations')"
          autocomplete="off" autocorrect="off" spellcheck="false" @keydown="onKey"
        >
        <button v-if="query" type="button" class="global-search-clear" :aria-label="t('Clear search')" @click="clearQuery"><UIcon name="i-lucide-x" /></button>
      </div>
      <div id="global-search-results" ref="list" class="global-search-list" role="listbox" :aria-label="t('Results')">
        <p v-if="query.trim().length < 2" class="global-search-note">{{ t('Enter at least two characters.') }}</p>
        <p v-else-if="busy && !count" class="global-search-note"><i class="global-search-pulse" />{{ t('Searching…') }}</p>
        <p v-else-if="error && !agentMatches.length" class="global-search-note bad">{{ error }}</p>
        <p v-else-if="!busy && !count" class="global-search-note">{{ t('No results') }}</p>
        <button v-for="(p, index) in agentMatches" :id="hitId(index)" :key="p.id" type="button" role="option" tabindex="-1" :aria-selected="index === active" class="global-search-agent-match" :class="{ active: index === active }" @mousemove="active = index" @click="chooseAgent(p)">
          <AgentAvatar :agent="p.agent" />
          <span class="global-search-agent-main"><span class="global-search-agent-title">{{ paneTaskTitle(p) || homeTitle(p, herdrState.workspaces.find(w => w.id === p.workspace)) }}</span><span class="global-search-agent-meta"><StatusPill :pane="p" kind /><span v-if="conversationSubtitle(p, herdrState.workspaces.find(w => w.id === p.workspace))">{{ conversationSubtitle(p, herdrState.workspaces.find(w => w.id === p.workspace)) }}</span></span></span>
          <UIcon name="i-lucide-arrow-up-right" />
        </button>
        <section v-for="g in groups" :key="g.id" class="global-search-group" :class="{ stale: busy }" role="group" :aria-label="g.title">
          <div class="global-search-agent">
            <AgentAvatar :agent="g.agent" />
            <div class="global-search-agent-main">
              <div class="global-search-agent-title">{{ g.title }}</div>
              <div class="global-search-agent-meta">
                <StatusPill :pane="g.pane" />
                <span v-if="g.subtitle">{{ g.subtitle }}</span>
                <span v-if="g.machine" class="global-search-machine"><UIcon :name="g.machineIcon" />{{ g.machine }}</span>
              </div>
            </div>
            <span class="global-search-count">{{ g.items.length }}</span>
          </div>
          <button
            v-for="{ hit, index } in g.items" :id="hitId(index + hitBase)" :key="`${hit.pane}:${hit.offset}:${hit.text}`"
            type="button" role="option" tabindex="-1" :aria-selected="index + hitBase === active"
            class="global-search-hit" :class="{ active: index + hitBase === active }"
            @mousemove="active = index + hitBase" @click="choose(hit)"
          >
            <span class="global-search-excerpt"><template v-for="(part, i) in highlightParts(hit.excerpt, query)" :key="i"><mark v-if="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
            <span class="global-search-meta">
              <span :class="['global-search-role', hit.role === 'user' ? 'user' : hit.agent]">{{ roleLabel(hit) }}</span>
              <template v-if="hit.ts"><span class="sep">·</span><time :datetime="hit.ts">{{ fmtWhen(hit.ts) }}</time></template>
            </span>
          </button>
        </section>
        <p v-if="limited && !busy" class="global-search-foot">{{ t('Results limited. Refine your search.') }}</p>
      </div>
      <footer v-if="desk" class="global-search-keys">
        <span><kbd>↑</kbd><kbd>↓</kbd>{{ t('navigate') }}</span>
        <span><kbd>↵</kbd>{{ t('open') }}</span>
        <span><kbd>esc</kbd>{{ t('close') }}</span>
      </footer>
    </section>
  </div>
</template>
