<script setup lang="ts">
// Rename a pane, or a tab (its terminal): the name goes into herdr-core, so it
// is visible everywhere. A pane can go back to its automatic name.
const open = computed({
  get: () => Boolean(renameTarget.value),
  set: (v) => { if (!v) renameTarget.value = null },
})
const pane = computed(() => herdrState.value.panes.find(p => p.id === renameTarget.value))
const value = ref('')
const input = ref<{ inputRef?: HTMLInputElement } | null>(null)
function focusInput() {
  setTimeout(() => {
    input.value?.inputRef?.focus()
    input.value?.inputRef?.select()
  }, 80)
}
const title = computed(() => (renameAs.value === 'tab' ? t('Rename tab') : t('Rename pane')))
watch(renameTarget, (id) => {
  if (!id) { renameAs.value = 'pane'; return }
  const p = pane.value
  value.value = p ? p.label || paneTitle(p) : ''
  focusInput()
})
async function save(label: string) {
  const id = renameTarget.value
  if (!id) return
  try {
    await api('/api/rename', { pane_id: id, label })
    renameTarget.value = null
    toast(label ? t('Renamed') : t('Automatic name restored'))
  } catch (err) { toast((err as Error).message, true) }
}
</script>

<template>
  <AppSheet v-model:open="open" :title="title" screen>
    <form id="rename-form" class="rename" @submit.prevent="save(value.trim())">
      <UInput ref="input" v-model="value" maxlength="60" size="xl" class="w-full" :placeholder="renameAs === 'tab' ? t('Tab name (empty = automatic name)') : t('Pane name (empty = automatic name)')" />
    </form>
    <template #footer>
      <div class="rename-actions">
        <UButton v-if="pane && pane.label" color="neutral" variant="ghost" class="sheet-btn" @click="save('')">{{ t('Reset') }}</UButton>
        <UButton type="submit" form="rename-form" color="primary" variant="solid" class="sheet-btn hw-cta">{{ t('Save') }}</UButton>
      </div>
    </template>
  </AppSheet>
</template>
