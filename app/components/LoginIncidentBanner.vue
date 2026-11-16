<script setup lang="ts">
// An account's login expired on a machine (GET /api/pm/logins): one notice
// for all its stuck agents, not one per task. Open a stuck agent's terminal to
// run /login there; once its credentials file changes, or on I logged in, the
// engine restarts each stuck agent with its conversation resumed.
interface Login { id: string, program: string, machine: string, tasks: number, renewed?: number, terminal?: string }

const logins = ref<Login[]>([])
const busy = ref('')
const load = () => api<Login[]>('/api/pm/logins').then((v) => { logins.value = Array.isArray(v) ? v : [] }, () => {})
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { load(); timer = setInterval(() => { if (!document.hidden) load() }, 15_000) })
onBeforeUnmount(() => clearInterval(timer))
const paneOf = (l: Login) => (l.terminal ? herdrState.value?.panes.find(p => p.coreAddress === l.terminal) : undefined)

async function renewed(l: Login) {
  haptic()
  busy.value = l.id
  try { await api('/api/pm/login-renewed', { id: l.id }); await load() }
  catch (e) { toast((e as Error).message, true) }
  finally { busy.value = '' }
}
</script>

<template>
  <div v-for="l in logins" :key="l.id" class="update-banner login-banner" role="alert" data-testid="login-banner">
    <UIcon name="i-lucide-key-round" class="update-banner-icon" />
    <div class="update-banner-body">
      <p>{{ tl(`${l.program} login expired on ${l.machine}`) }}
        <small v-if="l.renewed">{{ tl(`Login renewed: wherdr restarts the ${l.tasks === 1 ? 'stuck agent' : `${l.tasks} stuck agents`}, one after another.`) }}</small>
        <small v-else>{{ tl(`Run /login once there: wherdr restarts the ${l.tasks === 1 ? 'stuck agent' : `${l.tasks} stuck agents`} after, conversations resumed.`) }}</small>
      </p>
    </div>
    <div v-if="!l.renewed" class="update-banner-actions">
      <UButton v-if="paneOf(l)" size="sm" color="neutral" variant="ghost" icon="i-lucide-square-terminal" :to="panePath(paneOf(l)!.id)">{{ t('Open a terminal there') }}</UButton>
      <UButton size="sm" color="primary" variant="soft" icon="i-lucide-check" :loading="busy === l.id" @click="renewed(l)">{{ t('I logged in') }}</UButton>
    </div>
  </div>
</template>
