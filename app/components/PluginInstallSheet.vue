<script setup lang="ts">
// Settings › Plugins › Install from GitHub: owner/repo[@ref] → what will be
// installed (manifest, repo, exact commit) and the full-access warning, then
// Install or Cancel. Nothing is written before Install.
import type { PluginPreview } from '~/composables/useClientPlugins'

const open = defineModel<boolean>('open', { default: false })
const spec = ref('')
const preview = ref<PluginPreview | null>(null)
const error = ref('')
const busy = ref(false)
watch(open, (v) => { if (v) { spec.value = ''; preview.value = null; error.value = '' } })
watch(spec, () => { preview.value = null; error.value = '' })

async function run(fn: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try { await fn() } catch (e) { error.value = (e as Error).message } finally { busy.value = false }
}
const lookUp = () => run(async () => { preview.value = await previewPlugin(spec.value) })
const install = () => run(async () => {
  const p = preview.value!
  await installPlugin(p.source)
  open.value = false
  toast(`${t('Plugin installed')}: ${p.name}`)
})
</script>

<template>
  <AppSheet v-model:open="open" :title="t('Install from GitHub')">
    <form id="plugin-install-form" class="plugin-install" @submit.prevent="lookUp">
      <UInput v-model="spec" size="xl" class="w-full" placeholder="owner/repo" autocapitalize="off" autocomplete="off" spellcheck="false" />
      <p class="settings-hint">{{ t('Optionally followed by @tag, @branch or @commit. Default: the latest release, else the default branch.') }}</p>
      <p v-if="error" class="client-plugin-error" role="alert">{{ error }}</p>
      <div v-if="preview" class="plugin-install-preview" data-wherdr="plugin-install-preview">
        <div class="client-plugin-head">
          <strong>{{ preview.name }}</strong>
          <small v-if="preview.version">{{ preview.version }}</small>
        </div>
        <p v-if="preview.description" class="client-plugin-note">{{ preview.description }}</p>
        <dl>
          <dt>{{ t('Repository') }}</dt><dd>{{ preview.source.repo }}<template v-if="preview.resolved"> @ {{ preview.resolved }}</template></dd>
          <dt>{{ t('Commit') }}</dt><dd><code>{{ preview.source.commit }}</code></dd>
          <dt>{{ t('Folder') }}</dt><dd><code>plugins/{{ preview.id }}/</code></dd>
        </dl>
        <p class="plugin-install-warning" role="alert">
          {{ t('Plugins run inside wherdr with full access: they can read your conversations, write to your agents and run commands on your machines. Only turn this on for plugins you trust.') }}
          {{ t('Installing turns Community plugins on.') }}
        </p>
      </div>
    </form>
    <template #footer>
      <div class="plugin-install-actions">
        <UButton color="neutral" variant="ghost" class="sheet-btn" @click="open = false">{{ t('Cancel') }}</UButton>
        <UButton v-if="preview" color="primary" variant="solid" class="sheet-btn hw-cta" :loading="busy" @click="install">{{ preview.update ? t('Update') : t('Install') }}</UButton>
        <UButton v-else type="submit" form="plugin-install-form" color="primary" variant="solid" class="sheet-btn hw-cta" :loading="busy" :disabled="!spec.trim()">{{ t('Look up') }}</UButton>
      </div>
    </template>
  </AppSheet>
</template>

<style scoped>
.plugin-install { display: flex; flex-direction: column; gap: 10px; }
.plugin-install .settings-hint { margin: 0; }
.plugin-install-preview { border: 1px solid var(--line); background: var(--bg-2); padding: 12px; }
.plugin-install-preview dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 8px 0; font-size: 13px; }
.plugin-install-preview dt { color: var(--dim); }
.plugin-install-preview dd { margin: 0; overflow-wrap: anywhere; }
.plugin-install-warning { margin: 8px 0 0; color: var(--danger); font-size: 13px; }
.plugin-install-actions { display: flex; justify-content: flex-end; gap: 8px; }
.client-plugin-head { display: flex; align-items: center; gap: 8px; }
.client-plugin-head small { font-family: var(--font-mono, monospace); font-size: 11px; text-transform: uppercase; color: var(--dim); }
.client-plugin-note { color: var(--dim); font-size: 13px; margin: 6px 0; }
.client-plugin-error { margin: 0; padding: 6px 8px; border: 1px solid var(--red, #c33); color: var(--red, #c33); font-family: var(--font-mono, monospace); font-size: 12px; overflow-wrap: anywhere; }
</style>
