<script setup lang="ts">
// herdr-core machines: those core reached (state and last error), reconnect, and
// add one over SSH (like `hc machine add`). The machine must already accept this
// host's SSH login: wherdr never asks for a password nor installs anything.
import { hasPort } from '#shared/coreCapabilities'
const target = ref('')
const name = ref('')
const adding = ref(false)
const busyKey = ref('')
const error = ref('')
// Rename/forget show at once: the live state needs a few seconds to follow, so the
// old row is hidden right away and the renamed one borrows its state until it is online.
const gone = ref<string[]>([])
const renamedTo = ref<Record<string, string>>({})
const remote = computed(() => machines.value.filter(m => !m.local && !gone.value.includes(m.key)).map((m) => {
  const from = renamedTo.value[m.label]
  return from && m.status !== 'online' ? { ...m, status: 'connecting' as const, error: undefined } : m
}))
const STATE: Record<string, string> = { online: 'connected', connecting: 'connecting…', offline: 'offline' }

async function add() {
  if (!target.value.trim() || adding.value || portRefused.value) return
  adding.value = true
  error.value = ''
  try {
    await api('/api/machine/add', { target: target.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}) })
    toast(t('Machine added'))
    target.value = ''
    name.value = ''
    loadConfig()
  } catch (err) { error.value = (err as Error).message }
  finally { adding.value = false }
}
const renaming = ref('')
const newName = ref('')
const status = ref<{ version: string, uptimeMs: number, live: number, name: string | null, hostPort: boolean | null } | null>(null)
// `user@host:2222` only when the core says it takes a port (unknown: let it try).
const noPort = computed(() => status.value?.hostPort === false)
const portRefused = computed(() => noPort.value && hasPort(target.value))
// "Core 0.1.17 · running since 3 h" from server.status.
function upFor(ms: number) {
  const m = Math.floor(ms / 60000)
  if (m < 1) return tl('less than a minute', 'moins d’une minute')
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} h` : tl(`${Math.floor(h / 24)} days`, `${Math.floor(h / 24)} jours`)
}
const coreLine = computed(() => status.value ? tl(`Core ${status.value.version} · running for ${upFor(status.value.uptimeMs)}`, `Core ${status.value.version} · en marche depuis ${upFor(status.value.uptimeMs)}`) : '')
async function loadStatus() { status.value = await api<NonNullable<typeof status.value>>('/api/machine/core').catch(() => null) }
onMounted(loadStatus)
function startRename(m: { key: string, label: string }) { renaming.value = m.key; newName.value = m.label; error.value = '' }
async function rename(key: string) {
  const name = newName.value.trim()
  if (!name || busyKey.value) return
  busyKey.value = key
  error.value = ''
  try {
    await api('/api/machine/core-rename', { key, name })
    gone.value = [...gone.value, key]
    renamedTo.value = { ...renamedTo.value, [name]: key }
    setTimeout(() => { delete renamedTo.value[name]; renamedTo.value = { ...renamedTo.value }; gone.value = gone.value.filter(k => k !== key) }, 15000)
    renaming.value = ''
    loadConfig()
  } catch (err) { error.value = (err as Error).message }
  finally { busyKey.value = '' }
}
async function forget(m: { key: string, label: string }) {
  haptic()
  const ok = await askConfirm(
    tl(`Forget ${m.label}? Its terminals keep running there; you can add the machine again later.`,
      `Oublier ${m.label} ? Ses terminaux continuent de tourner là-bas ; tu pourras rajouter la machine plus tard.`),
    tl('Forget', 'Oublier'), 'error')
  if (!ok) return
  busyKey.value = m.key
  error.value = ''
  try {
    await api('/api/machine/core-forget', { key: m.key })
    gone.value = [...gone.value, m.key]
    setTimeout(() => { gone.value = gone.value.filter(k => k !== m.key) }, 15000)
    loadConfig()
  }
  catch (err) { error.value = (err as Error).message }
  finally { busyKey.value = '' }
}
async function reconnect(key: string) {
  busyKey.value = key
  error.value = ''
  try { await api('/api/machine/connect', { key }) }
  catch (err) { error.value = (err as Error).message }
  finally { busyKey.value = '' }
}
</script>

<template>
  <div class="settings-group core-machines">
    <h3>{{ t('Machines') }}</h3>
    <p class="muted settings-hint">{{ t('Other machines running herdr-core, reached over SSH. Terminals and agents can be started on them from New.') }}</p>
    <div class="settings-card">
      <div class="machine-row"><b>{{ hostLabel || t('This machine') }}</b><span class="mono-label">{{ t('this machine') }}</span></div>
      <div v-for="m in remote" :key="m.key" class="machine-row" data-testid="core-machine">
        <form v-if="renaming === m.key" class="rename-form" @submit.prevent="rename(m.key)">
          <UInput v-model="newName" size="lg" class="w-full mono" autocapitalize="none" autocorrect="off" :spellcheck="false" maxlength="32" :aria-label="t('Name')" autofocus />
          <UButton type="submit" size="sm" color="primary" variant="solid" :loading="busyKey === m.key" :disabled="!newName.trim()">{{ t('Save') }}</UButton>
          <UButton type="button" size="sm" color="neutral" variant="outline" @click="renaming = ''">{{ t('Cancel') }}</UButton>
        </form>
        <template v-else>
          <span><b>{{ m.label }}</b><small v-if="m.error" class="muted">{{ m.error }}</small></span>
          <span class="mono-label" :data-status="m.status">{{ t(STATE[m.status] || m.status) }}</span>
          <UButton v-if="m.status !== 'online'" color="neutral" variant="outline" size="sm" :loading="busyKey === m.key" @click="reconnect(m.key)">{{ t('Reconnect') }}</UButton>
          <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-pencil" :aria-label="t('Rename')" data-testid="machine-rename" @click="startRename(m)" />
          <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-trash-2" :aria-label="tl('Forget', 'Oublier')" data-testid="machine-forget" @click="forget(m)" />
        </template>
      </div>
    </div>
    <p v-if="coreLine" class="mono-label core-line" data-testid="core-line">{{ coreLine }}</p>
    <form class="sheet-form" @submit.prevent="add">
      <label class="field-label" for="machineTarget">{{ t('SSH target') }}</label>
      <UInput id="machineTarget" v-model="target" size="xl" class="w-full mono" autocapitalize="none" autocorrect="off" :spellcheck="false" :placeholder="noPort ? 'user@10.0.0.7' : 'user@10.0.0.7:22'" maxlength="200" :aria-describedby="portRefused ? 'machinePortHint' : undefined" />
      <p v-if="portRefused" id="machinePortHint" class="muted settings-hint" data-testid="machine-port-hint">{{ t('This herdr-core takes no port: update it, or use a Host from ~/.ssh/config') }}</p>
      <label class="field-label" for="machineName">{{ t('Name') }} <span class="muted">{{ t('(optional)') }}</span></label>
      <UInput id="machineName" v-model="name" size="xl" class="w-full mono" autocapitalize="none" autocorrect="off" :spellcheck="false" placeholder="vps" maxlength="32" />
      <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
      <UButton type="submit" size="xl" color="primary" variant="solid" class="hw-cta" icon="i-lucide-plus" :loading="adding" :disabled="!target.trim() || portRefused">{{ t('Add machine') }}</UButton>
    </form>
  </div>
</template>

<style scoped>
.machine-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 16px; border-bottom: 1px solid var(--line); }
.machine-row:last-child { border-bottom: 0; }
.machine-row span:first-child { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.mono-label[data-status='online'] { color: var(--green, var(--text)); }
.core-machines .settings-card { padding: 0; margin-top: 12px; }
.rename-form { display: flex; gap: 8px; width: 100%; align-items: center; }
.core-line { margin-top: 8px; }
.core-machines form.sheet-form { margin-top: 16px; }
</style>
