<script setup lang="ts">
import type { PluginSource } from '#shared/clientPlugins'
import type { PluginPreview } from '~/composables/useClientPlugins'
import type { PluginRow } from '~/utils/pluginHost'
// Settings › Plugins › wherdr plugins: the plugins found in DATA_DIR/plugins,
// their state, and a switch each. A plugin that failed stays off with its message.
// Nothing loads while Community plugins is off: each plugin keeps its switch, greyed.
const rows = clientPlugins
onMounted(() => { startClientPlugins() })
async function setCommunity(on: boolean) {
  if (on && !(await askConfirm(t('Plugins run inside wherdr with full access: they can read your conversations, write to your agents and run commands on your machines. Only turn this on for plugins you trust.'), t('Turn on')))) return
  communityPlugins.value = on
}
const installing = ref(false)
// Check for update: the newer commit found per plugin (never installed without Update).
const updates = ref<Record<string, PluginPreview | null | undefined>>({})
const busy = ref('')
const short = (sha: string) => sha.slice(0, 7)
const commitUrl = (s: PluginSource) => `https://github.com/${s.repo}/tree/${s.commit}`
async function act(id: string, fn: () => Promise<void>) {
  busy.value = id
  try { await fn() } catch (e) { toast((e as Error).message, true) } finally { busy.value = '' }
}
const check = (id: string) => act(id, async () => {
  const u = await checkPluginUpdate(id)
  updates.value = { ...updates.value, [id]: u }
  if (!u) toast(t('Up to date'))
})
const update = (id: string) => act(id, async () => {
  const u = updates.value[id]
  if (!u) return
  await updatePlugin(u.source)
  updates.value = { ...updates.value, [id]: undefined }
  toast(`${t('Plugin updated')}: ${u.name}`)
})
const remove = (p: PluginRow) => act(p.id, async () => {
  if (!(await askConfirm(`${t('Remove this plugin? Its folder is deleted.')} (${p.name})`, t('Remove')))) return
  await removePlugin(p.id)
})
const stateText = (s: string) => ({
  running: tl('On', 'Activé'), off: tl('Off', 'Désactivé'), failed: tl('Disabled after an error', 'Désactivé après une erreur'), loading: tl('Loading…', 'Chargement…'),
}[s] || s)
</script>

<template>
  <div class="settings-group client-plugins">
    <h3>{{ tl('wherdr plugins', 'Plugins wherdr') }}</h3>
    <label class="settings-toggle" data-wherdr="community-plugins">
      <span><b>{{ t('Community plugins') }}</b><small>{{ t('Lets the plugins below load, with full access to wherdr. Off by default. Applies to every device.') }}</small></span>
      <USwitch :model-value="communityPlugins" size="xl" @update:model-value="setCommunity" />
    </label>
    <div class="client-plugins-install">
      <UButton size="sm" color="neutral" variant="outline" class="mono-btn" icon="i-lucide-download" @click="installing = true">{{ t('Install from GitHub') }}</UButton>
    </div>
    <PluginInstallSheet v-model:open="installing" />
    <p v-if="!rows.length" class="client-plugins-empty">
      {{ t('No plugin installed. Install one from GitHub, or put a plugin folder in the plugins folder of the data directory (plugins/<name>/manifest.json) and reload the page.') }}
    </p>
    <ul v-else class="client-plugins-list" :class="{ paused: !communityPlugins }">
      <li v-for="p in rows" :key="p.id" class="client-plugin" :class="p.status" :data-plugin="p.id">
        <div class="client-plugin-head">
          <strong>{{ p.name }}</strong>
          <small v-if="p.version">{{ p.version }}</small>
          <span v-if="communityPlugins" class="client-plugin-state">{{ stateText(p.status) }}</span>
          <USwitch
            :model-value="communityPlugins ? p.status === 'running' || p.status === 'loading' : p.wanted" :aria-label="p.name" :disabled="!communityPlugins"
            @update:model-value="(v: boolean) => setClientPluginEnabled(p.id, v)"
          />
        </div>
        <p v-if="p.description" class="client-plugin-note">{{ p.description }}</p>
        <p v-if="p.status === 'failed'" class="client-plugin-error" role="alert">{{ p.error }}</p>
        <div class="client-plugin-source">
          <a v-if="p.source" :href="commitUrl(p.source)" target="_blank" rel="noopener">{{ p.source.repo }} @ <code>{{ short(p.source.commit) }}</code></a>
          <span v-if="p.source && updates[p.id]" class="client-plugin-update">{{ t('New') }}: <code>{{ short(updates[p.id]!.source.commit) }}</code><template v-if="updates[p.id]!.version"> ({{ updates[p.id]!.version }})</template></span>
          <span class="client-plugin-actions">
            <template v-if="p.source">
              <UButton v-if="updates[p.id]" size="sm" color="primary" variant="outline" class="mono-btn" :loading="busy === p.id" @click="update(p.id)">{{ t('Update') }}</UButton>
              <UButton v-else size="sm" color="neutral" variant="outline" class="mono-btn" :loading="busy === p.id" @click="check(p.id)">{{ t('Check for update') }}</UButton>
            </template>
            <UButton size="sm" color="neutral" variant="ghost" class="mono-btn" :disabled="busy === p.id" @click="remove(p)">{{ t('Remove') }}</UButton>
          </span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.client-plugins-empty, .client-plugin-note { color: var(--dim); font-size: 13px; margin: 6px 0; }
.client-plugins-list { list-style: none; margin: 0; padding: 0; }
.client-plugin { border-top: 1px solid var(--line); padding: 10px 0; }
/* Community plugins off: each plugin keeps its switch, greyed. */
.client-plugins-list.paused .client-plugin { opacity: .5; }
.client-plugin-head { display: flex; align-items: center; gap: 8px; }
.client-plugin-head strong { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.client-plugin-head small, .client-plugin-state { font-family: var(--font-mono, monospace); font-size: 11px; text-transform: uppercase; color: var(--dim); }
.client-plugin-error { margin: 6px 0 0; padding: 6px 8px; border: 1px solid var(--red, #c33); color: var(--red, #c33); font-family: var(--font-mono, monospace); font-size: 12px; overflow-wrap: anywhere; }
.client-plugins-install { margin: 10px 0; }
.client-plugin-source { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 6px; font-size: 12px; color: var(--dim); }
.client-plugin-source a { color: inherit; text-decoration: underline; overflow-wrap: anywhere; }
.client-plugin-update { color: var(--text, inherit); }
.client-plugin-actions { display: flex; gap: 6px; margin-left: auto; }
@media (pointer: coarse) { .client-plugins-install :deep(button), .client-plugin-actions :deep(button) { min-height: 44px; } }
</style>
