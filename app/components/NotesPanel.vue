<script setup lang="ts">
// Notes (shared/notes.ts): the whiteboard agents write, read-only for the
// user. Beside the conversation (or Home's list) on a computer with room, in
// place of the Settings panel; otherwise a sheet. Read again every few seconds while open.
import { isConversationPath } from '~/utils/settingsPanel'

const route = useRoute()
const router = useRouter()
const panel = computed(() => sidePanelRoom.value && (route.path === '/' || isConversationPath(route.path)))
const sheetOpen = computed({ get: () => notesOpen.value && !panel.value, set: (v) => { notesOpen.value = v } })
const close = () => { notesOpen.value = false }
// A link followed from the sheet leaves it; the panel stays beside the conversation.
const leave = () => { if (!panel.value) close() }

let timer: ReturnType<typeof setInterval> | undefined
watch(notesOpen, (open) => {
  clearInterval(timer)
  if (!open) return
  loadNotes()
  timer = setInterval(() => { if (!document.hidden) loadNotes() }, 4000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(timer))

// One panel at a time: Settings or an agent's `ui show` closes Notes, and
// Notes opened closes them.
watch(() => route.query.section, (s) => { if (typeof s === 'string' && panel.value) close() })
watch(uiShown, (v) => { if (v) close() })
watch(notesOpen, (v) => {
  if (!v || !panel.value) return
  uiShown.value = null
  if (typeof route.query.section === 'string') router.replace({ query: { ...route.query, section: undefined, tab: undefined, target: undefined } })
})
</script>

<template>
  <aside v-if="notesOpen && panel" id="notes" class="notes-panel" :aria-label="tl('Notes')" data-testid="notes-panel">
    <SidePanelHandle controls="notes" />
    <header class="ui-show-top">
      <div class="ui-show-head"><h2>{{ tl('Notes') }}</h2></div>
      <button type="button" class="ui-open-x" :aria-label="t('Close')" :title="t('Close')" @click="close">
        <UIcon name="i-lucide-x" />
      </button>
    </header>
    <div class="ui-show-body"><NotesList @leave="leave" /></div>
  </aside>
  <AppSheet v-else-if="!panel" v-model:open="sheetOpen" :title="tl('Notes')" wide full screen>
    <NotesList @leave="leave" />
  </AppSheet>
</template>
