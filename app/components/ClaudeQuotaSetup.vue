<script setup lang="ts">
// Claude quota status line of each machine with Claude: its state, Install or
// Update (the server runs the script, over SSH on a remote machine) and Copy
// command (self-contained, to paste over there). Settings › Agents and the
// setup guide's Quotas step; the home list only has an item in the machine's
// "…" menu that leads here.
import type { ClaudeSetupRow } from '~/utils/quotas'

// `declined`: also list the machines whose setup was declined (Settings); the
// setup guide leaves them out, they are no longer suggested there.
const props = withDefaults(defineProps<{ intro?: boolean, declined?: boolean }>(), { intro: true, declined: true })

const rows = computed(() => props.declined ? claudeSetupList.value : claudeSetupList.value.filter(r => !r.setup?.dismissed))
const busy = ref<Record<string, boolean>>({})
onMounted(reloadQuotas)

function stateText(r: ClaudeSetupRow): string {
  if (!r.online) return tl('Offline', 'Hors ligne')
  switch (r.setup?.state) {
    case 'ok': return tl('Set up', 'Configurés')
    case 'pending': return tl('Installed', 'Installés')
    case 'outdated': return tl('Update available', 'Mise à jour disponible')
    case 'missing': return tl('Not set up', 'Non configurés')
    case 'api': return tl('API usage (no quota)', 'Usage API (pas de quota)')
    default: return homeQuotas.value ? tl('Status unavailable', 'État indisponible') : tl('Checking…', 'Vérification…')
  }
}
const offer = (r: ClaudeSetupRow) => r.online && (r.setup?.state === 'missing' || r.setup?.state === 'outdated')

async function install(r: ClaudeSetupRow) {
  busy.value = { ...busy.value, [r.key]: true }
  try { await installClaudeQuotas(r.key, r.name, r.setup?.state === 'outdated') }
  finally { busy.value = { ...busy.value, [r.key]: false } }
}
</script>

<template>
  <div class="claude-quotas">
    <p v-if="intro" class="muted settings-lead">{{ tl('Claude Code only gives its quotas to its status line. wherdr’s status line displays nothing and keeps the one you have; the quotas then show on the home screen after the next exchange with a Claude.', 'Claude Code ne donne ses quotas qu’à sa barre d’état. Celle de wherdr n’affiche rien et garde la tienne ; les quotas apparaissent ensuite sur l’accueil après le prochain échange avec un Claude.') }}</p>
    <p v-if="!rows.length" class="muted claude-quotas-empty">{{ tl('Claude Code is not installed on the online machines.', 'Claude Code n’est installé sur aucune machine en ligne.') }}</p>
    <div v-for="r in rows" :key="r.key" class="claude-quotas-machine" :data-machine="r.key || 'local'">
      <div class="claude-quotas-head">
        <strong>{{ r.name }}</strong>
        <span :class="r.online ? r.setup?.state : 'offline'">{{ stateText(r) }}</span>
      </div>
      <p v-if="r.online && r.setup?.state === 'api'" class="claude-quotas-note">{{ tl('Claude Code runs on API billing here (API key or Console credits): no usage limits to show.', 'Claude Code tourne ici en facturation API (clé API ou crédits Console) : pas de limites d’usage à afficher.') }}</p>
      <p v-else-if="r.online && r.setup?.state === 'pending'" class="claude-quotas-note">{{ t('They will show after the next exchange with a Claude.') }}</p>
      <p v-else-if="r.online && r.setup?.state === 'outdated'" class="claude-quotas-note">{{ tl('An older status line is installed. Update it so that a change of Claude account, or API usage, is seen at once.', 'Une ancienne barre d’état est installée. Mets-la à jour pour qu’un changement de compte Claude, ou un usage API, soit vu tout de suite.') }}</p>
      <template v-if="offer(r)">
        <p v-if="!r.setup!.installable" class="claude-quotas-note">{{ tl(`Home folder is read-only here: copy the command and paste it into a terminal on ${r.name}.`, `Dossier personnel en lecture seule ici : copie la commande et colle-la dans un terminal de ${r.name}.`) }}</p>
        <div class="claude-quotas-actions">
          <UButton v-if="r.setup!.installable" size="sm" color="primary" variant="solid" class="hw-cta" icon="i-lucide-download" :loading="busy[r.key]" @click="install(r)">
            {{ r.setup!.state === 'outdated' ? tl('Update', 'Mettre à jour') : t('Install') }}
          </UButton>
          <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-copy" @click="copyClaudeQuotasCommand(r.name)">{{ t('Copy command') }}</UButton>
        </div>
      </template>
    </div>
  </div>
</template>
