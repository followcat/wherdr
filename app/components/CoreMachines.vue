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
  return from && m.status !== 'online' ? { ...m, status: 'connecting' as const, error: null } : m
}))
// This machine first, then the others; memory rows follow the machines' keys.
const cards = computed(() => [
  { key: machines.value.find(m => m.local)?.key ?? '', label: hostLabel.value || t('This machine'), local: true, status: 'online' as const, error: null },
  ...remote.value,
])
onMounted(loadMemory)
watch(() => machines.value.map(m => m.key).join(), (_now, before) => { if (before !== undefined) loadMemory() })

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
async function rename(key: string, name: string) {
  if (busyKey.value) return
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
    t('Forget'), 'error')
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
    <p class="muted settings-hint">{{ t('Other machines running herdr-core, reached over SSH. Terminals and agents can be started on them from New.') }}</p>
    <div class="machine-list">
      <MachineCard
        v-for="m in cards" :key="m.key" :machine="m" :memory="memoryRows?.find(r => r.key === m.key)"
        :busy="!m.local && busyKey === m.key" :editing="!m.local && renaming === m.key"
        @edit="renaming = m.key; error = ''" @cancel="renaming = ''" @save="rename(m.key, $event)" @forget="forget(m)" @reconnect="reconnect(m.key)"
      />
    </div>
    <p v-if="memoryError" class="form-error" role="alert">{{ memoryError }}</p>
    <p class="muted settings-hint">{{ memoryHint() }}</p>
    <p v-if="coreLine" class="mono-label core-line" data-testid="core-line">{{ coreLine }}</p>
    <form class="sheet-form" data-ui-target="machines.add" @submit.prevent="add">
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
.machine-list { display: grid; gap: 8px; margin-top: 12px; }
.core-machines .machine-list + .form-error { margin-top: 12px; }
.core-line { margin-top: 8px; }
.core-machines form.sheet-form { margin-top: 16px; }
</style>
