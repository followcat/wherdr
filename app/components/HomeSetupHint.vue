<script setup lang="ts">
// Home's empty state, while wherdr has no project: a short line, Alfred to set
// the first one up with the user (askAlfred, as the setup window's "Let Alfred
// guide me"), and the setup window itself. Nothing once a project exists.
import type { PmOverview } from '#shared/pm/project'

const shown = ref(false)
const open = ref(false)
const busy = ref(false)
const error = ref('')
const load = () => api<PmOverview>('/api/pm/overview').then((o) => { shown.value = !o.projects.length }, () => {})
onMounted(load)

async function toAlfred() {
  busy.value = true
  error.value = ''
  try { await askAlfred(ALFRED_SETUP_PROMPT) }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <div v-if="shown" class="home-setup" data-testid="home-setup">
    <p class="muted">{{ tl('No project yet. Alfred can set the first one up with you.') }}</p>
    <UButton color="primary" size="lg" icon="i-lucide-message-circle" :loading="busy" data-testid="home-setup-alfred" @click="toAlfred">{{ tl('Set up a project with Alfred') }}</UButton>
    <UButton color="neutral" variant="ghost" size="lg" icon="i-lucide-list-checks" :disabled="busy" data-testid="home-setup-window" @click="open = true">{{ tl('Open the setup window') }}</UButton>
    <p v-if="error" class="form-error">{{ error }}</p>
    <SetupWizard v-model:open="open" @changed="load" />
  </div>
</template>

<style scoped>
.home-setup { display: grid; justify-items: center; gap: 8px; margin-top: 16px; }
.home-setup p { margin: 0; }
</style>
