<script setup lang="ts">
// What an agent showed with `ui show` (shared/uiShow.ts): a file of its folder
// (FilesView, read-only) or a task's screenshots (UiShowShots). Beside the
// conversation on a computer with room, in place of the Settings panel;
// otherwise in a sheet. Leaving the conversation closes it.
import { showLabel } from '#shared/uiShow'
import { isConversationPath } from '~/utils/settingsPanel'

const route = useRoute()
const router = useRouter()
const e = uiShown
const panel = computed(() => sidePanelRoom.value)
const title = computed(() => (e.value ? showLabel(e.value) : ''))
const close = () => { uiShown.value = null }
const sheetOpen = computed({ get: () => !!e.value && !panel.value, set: (v) => { if (!v) close() } })

// One panel at a time: Settings opened closes this one, and the other way round.
watch(() => route.query.section, (s) => { if (typeof s === 'string') close() })
watch(e, (v) => {
  if (v && panel.value && typeof route.query.section === 'string') router.replace({ query: { ...route.query, section: undefined, tab: undefined, target: undefined } })
})
watch(() => route.path, close)
</script>

<template>
  <aside v-if="e && panel && isConversationPath(route.path)" id="ui-show" class="ui-show-panel" :aria-label="title" data-testid="ui-show-panel">
    <header class="ui-show-top">
      <div class="ui-show-head">
        <span class="ui-open-by">{{ tl(`Shown by ${e.by || 'the agent'}`) }}</span>
        <h2>{{ title }}</h2>
      </div>
      <button type="button" class="ui-open-x" :aria-label="t('Close')" :title="t('Close')" @click="close">
        <UIcon name="i-lucide-x" />
      </button>
    </header>
    <div class="ui-show-body">
      <FilesView v-if="e.what === 'file'" :key="`${e.pane}:${e.arg}`" :pane-id="e.pane" :file="e.arg" in-folder />
      <UiShowShots v-else :key="e.arg" :task="e.arg" />
    </div>
  </aside>
  <AppSheet v-else-if="!panel" v-model:open="sheetOpen" :title="title" wide full screen>
    <template v-if="e">
      <FilesView v-if="e.what === 'file'" :key="`${e.pane}:${e.arg}`" :pane-id="e.pane" :file="e.arg" in-folder />
      <UiShowShots v-else :key="e.arg" :task="e.arg" />
    </template>
  </AppSheet>
</template>
