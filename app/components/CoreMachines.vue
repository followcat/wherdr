<script setup lang="ts">
// herdr-core machines: those core reached (state and last error), reconnect, and
// add one over SSH (like `hc machine add`). The machine must already accept this
// host's SSH login: wherdr never asks for a password nor installs anything.
import { hasPort } from '#shared/coreCapabilities'
import { readHcSockets } from '#shared/settings'
const target = ref('')
const name = ref('')
const adding = ref(false)
const busyKey = ref('')
const error = ref('')
// Add machine: a sheet with the form, then a confirmation (what will happen), then the
// progress; an error keeps it open on the confirmation, with the message and what to do.
const addOpen = ref(false)
const step = ref<'form' | 'confirm'>('form')
const addError = ref('')
// The card of the machine just added, highlighted for a few seconds.
const fresh = ref('')
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

// Extra hc sessions on this computer. Those from HC_SOCKETS are shown read-only;
// those saved in settings.hcSockets can be removed here. Adding is never
// automatic: Find local sessions only lists, one tap adds.
interface LocalSessions {
  directory: string | null
  primary: string
  envSockets: string[]
  settingsSockets: string[]
  available: { path: string, name: string }[]
}
const localSessions = ref<LocalSessions | null>(null)
const localSessionsError = ref('')
const findingSessions = ref(false)
const sessionsSearched = ref(false)
const configuredHcSockets = syncedRef<string[]>('hcSockets', readHcSockets, v => JSON.stringify(v), { deep: true })
const socketName = (socketPath: string) => (socketPath.split('/').pop() || socketPath).replace(/\.sock$/, '')
async function readLocalSessions() {
  localSessionsError.value = ''
  try { localSessions.value = await api<LocalSessions>('/api/machine/local-sessions') }
  catch (err) { localSessionsError.value = (err as Error).message }
}
onMounted(readLocalSessions)
const hcSessionRows = computed(() => {
  const env = new Set(localSessions.value?.envSockets ?? [])
  const settings = new Set(configuredHcSockets.value)
  const paths = [...new Set([...(localSessions.value?.envSockets ?? []), ...configuredHcSockets.value])]
  return paths.map(path => ({ path, name: socketName(path), env: env.has(path), settings: settings.has(path), removable: settings.has(path) && !env.has(path) }))
})
const availableHcSessions = computed(() => {
  if (!sessionsSearched.value || !localSessions.value) return []
  const used = new Set([...hcSessionRows.value.map(r => r.path), localSessions.value.primary])
  return localSessions.value.available.filter(s => !used.has(s.path))
})
async function findLocalSessions() {
  if (findingSessions.value) return
  findingSessions.value = true
  sessionsSearched.value = true
  await readLocalSessions()
  findingSessions.value = false
}
function addHcSession(path: string) {
  if (configuredHcSockets.value.includes(path)) return
  configuredHcSockets.value = [...configuredHcSockets.value, path]
  toast(t('Session added'))
}
function removeHcSession(path: string) {
  configuredHcSockets.value = configuredHcSockets.value.filter(x => x !== path)
  toast(t('Session removed'))
}

function openAdd() {
  target.value = ''
  name.value = ''
  step.value = 'form'
  addError.value = ''
  addOpen.value = true
}
function review() {
  if (!target.value.trim() || portRefused.value) return
  addError.value = ''
  step.value = 'confirm'
}
async function add() {
  if (!target.value.trim() || adding.value || portRefused.value) return
  adding.value = true
  addError.value = ''
  const before = new Set(machines.value.map(m => m.key))
  try {
    await api('/api/machine/add', { target: target.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}) })
    toast(t('Connected'))
    addOpen.value = false
    await loadConfig()
    fresh.value = machines.value.find(m => !before.has(m.key))?.key ?? ''
    setTimeout(() => { fresh.value = '' }, 6000)
  } catch (err) { addError.value = (err as Error).message }
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
    <UButton size="xl" color="primary" variant="solid" class="hw-cta add-machine" icon="i-lucide-plus" data-ui-target="machines.add" @click="openAdd">{{ t('Add machine') }}</UButton>
    <p class="muted settings-hint">{{ t('Other machines running herdr-core, reached over SSH. Terminals and agents can be started on them from New.') }}</p>
    <div class="machine-list">
      <MachineCard
        v-for="m in cards" :key="m.key" :machine="m" :memory="memoryRows?.find(r => r.key === m.key)"
        :class="{ fresh: !m.local && fresh === m.key }"
        :busy="!m.local && busyKey === m.key" :editing="!m.local && renaming === m.key"
        @edit="renaming = m.key; error = ''" @cancel="renaming = ''" @save="rename(m.key, $event)" @forget="forget(m)" @reconnect="reconnect(m.key)"
      />
    </div>
    <div class="extra-hc-sessions" data-testid="extra-hc-sessions">
      <h4 class="theme-section-title">{{ t('Extra sessions') }}</h4>
      <p class="muted settings-hint">{{ t('Other hc sessions on this computer. Changes apply immediately; nothing is attached automatically.') }}</p>
      <ul v-if="hcSessionRows.length" class="hc-session-list">
        <li v-for="row in hcSessionRows" :key="row.path" class="hc-session-row" data-testid="hc-session-row">
          <span class="hc-session-text"><b>{{ row.name }}</b><small class="mono">{{ row.path }}</small></span>
          <span class="card-tag hc-session-source">{{ row.env ? 'HC_SOCKETS' : t('Settings') }}</span>
          <button v-if="row.removable" type="button" class="hc-session-remove" :aria-label="`${t('Remove session')} ${row.name}`" data-testid="hc-session-remove" @click="removeHcSession(row.path)"><UIcon name="i-lucide-trash-2" /></button>
        </li>
      </ul>
      <p v-else class="muted settings-hint">{{ t('No extra sessions configured.') }}</p>
      <UButton color="neutral" variant="outline" icon="i-lucide-search" class="find-sessions" :loading="findingSessions" data-testid="find-local-sessions" @click="findLocalSessions">{{ t('Find local sessions') }}</UButton>
      <p v-if="localSessionsError" class="form-error" role="alert">{{ t(localSessionsError) }}</p>
      <ul v-if="availableHcSessions.length" class="hc-session-list available">
        <li v-for="session in availableHcSessions" :key="session.path">
          <button type="button" class="hc-session-add" data-testid="local-session-add" @click="addHcSession(session.path)">
            <span class="hc-session-text"><b>{{ session.name }}</b><small class="mono">{{ session.path }}</small></span>
            <UIcon name="i-lucide-plus" />
          </button>
        </li>
      </ul>
      <p v-else-if="sessionsSearched && !findingSessions && !localSessionsError" class="muted settings-hint">{{ t('No other local sessions found.') }}</p>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
    <p v-if="memoryError" class="form-error" role="alert">{{ memoryError }}</p>
    <p class="muted settings-hint">{{ memoryHint() }}</p>
    <p v-if="coreLine" class="mono-label core-line" data-testid="core-line">{{ coreLine }}</p>
    <AppSheet v-model:open="addOpen" :title="t('Add machine')">
      <form v-if="step === 'form'" id="machine-add-form" class="sheet-form" data-testid="machine-add-form" @submit.prevent="review">
        <label class="field-label" for="machineTarget">{{ t('SSH target') }}</label>
        <UInput id="machineTarget" v-model="target" size="xl" class="w-full mono" autocapitalize="none" autocorrect="off" :spellcheck="false" :placeholder="noPort ? 'user@10.0.0.7' : 'user@10.0.0.7:22'" maxlength="200" :aria-describedby="portRefused ? 'machinePortHint' : undefined" />
        <p v-if="portRefused" id="machinePortHint" class="muted settings-hint" data-testid="machine-port-hint">{{ t('This herdr-core takes no port: update it, or use a Host from ~/.ssh/config') }}</p>
        <label class="field-label" for="machineName">{{ t('Name') }} <span class="muted">{{ t('(optional)') }}</span></label>
        <UInput id="machineName" v-model="name" size="xl" class="w-full mono" autocapitalize="none" autocorrect="off" :spellcheck="false" placeholder="vps" maxlength="32" />
        <p class="muted settings-hint add-needs">{{ t('The machine needs herdr-core (hc) installed, and must accept this host\'s SSH key login without a password.') }}</p>
      </form>
      <div v-else class="add-confirm" data-testid="machine-add-confirm">
        <dl class="add-summary">
          <dt class="field-label">{{ t('SSH target') }}</dt><dd class="mono">{{ target.trim() }}</dd>
          <dt class="field-label">{{ t('Name') }}</dt><dd class="mono">{{ name.trim() || t('From the target') }}</dd>
        </dl>
        <p class="settings-hint add-needs">{{ adding ? t('Connecting over SSH and checking hc…') : t('wherdr will connect over SSH and check hc.') }}</p>
        <template v-if="addError">
          <p class="form-error" role="alert">{{ t(addError) }}</p>
          <p class="muted settings-hint">{{ t('Check that ssh to the target works without a password and that hc is on its PATH, then confirm again, or go back to fix the target.') }}</p>
        </template>
      </div>
      <template #footer>
        <div class="rename-actions">
          <UButton v-if="step === 'form'" color="neutral" variant="ghost" class="sheet-btn" @click="addOpen = false">{{ t('Cancel') }}</UButton>
          <UButton v-else color="neutral" variant="ghost" class="sheet-btn" :disabled="adding" @click="step = 'form'">{{ t('Back') }}</UButton>
          <UButton v-if="step === 'form'" type="submit" form="machine-add-form" color="primary" variant="solid" class="sheet-btn hw-cta" :disabled="!target.trim() || portRefused">{{ t('Add') }}</UButton>
          <UButton v-else color="primary" variant="solid" class="sheet-btn hw-cta" :loading="adding" data-testid="machine-add-confirm-btn" @click="add">{{ t('Confirm') }}</UButton>
        </div>
      </template>
    </AppSheet>
  </div>
</template>

<style scoped>
.add-machine { margin-bottom: 12px; }
.machine-list { display: grid; gap: 8px; margin-top: 12px; }
.core-machines .machine-list + .form-error { margin-top: 12px; }
.core-line { margin-top: 8px; }
.machine-card.fresh { box-shadow: inset 0 0 0 2px var(--accent); transition: box-shadow .3s; }
.add-summary { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px 16px; align-items: baseline; margin: 0 0 16px; }
.add-summary dt, .add-summary dd { margin: 0; }
.add-summary dd { overflow-wrap: anywhere; }
.add-confirm .form-error { margin-top: 12px; }
.add-needs { margin-top: 16px; }
.extra-hc-sessions { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--line); }
.hc-session-list { display: grid; gap: 0; margin: 10px 0; padding: 0; list-style: none; border: 1px solid var(--line); }
.hc-session-row, .hc-session-add {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 44px; padding: 5px 6px 5px 10px;
  background: var(--surface); color: var(--text); text-align: left;
}
.hc-session-list li + li { border-top: 1px solid var(--line-soft); }
.hc-session-add { border: 0; font: inherit; cursor: pointer; touch-action: manipulation; }
.hc-session-text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.hc-session-text b, .hc-session-text small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-session-text small { color: var(--dim); font-size: 10.5px; }
.hc-session-source { flex: none; }
.hc-session-remove {
  flex: none; width: 44px; height: 44px; display: grid; place-items: center; padding: 0; border: 0;
  background: transparent; color: var(--muted); cursor: pointer; touch-action: manipulation;
}
.hc-session-remove:hover { color: var(--danger); }
.find-sessions { margin-top: 8px; }
</style>
