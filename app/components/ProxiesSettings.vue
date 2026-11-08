<script setup lang="ts">
// Settings › Agents › Proxies: the named proxies the "New" sheet offers.
// Kept on the server, shared by every device: a password never comes back —
// the list shows user:•••@host:port, and an edit that leaves the mask keeps
// the stored password. A proxy is machine-relative: 127.0.0.1 names that
// machine's own. An entry may be offered on some machines only.
import type { ProxyEntry } from '#shared/proxies'

const list = ref<HTMLElement | null>(null)
const announcement = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

interface Draft { id?: string, name: string, url: string, noProxy: string, machines: string[] }
const editing = ref<Draft | null>(null)

onMounted(loadProxies)

const machineLabel = (key: string) => key ? (appConfig.value.machines?.find(m => m.key === key)?.label || key) : (appConfig.value.hostLabel || t('This machine'))
const machineHint = (p: ProxyEntry) => !p.machines?.length ? t('All machines') : p.machines.map(machineLabel).join(', ')

function move(id: string, to: number) {
  const from = proxies.value.findIndex(p => p.id === id)
  if (from === to || from < 0) return
  const next = [...proxies.value]
  next.splice(to, 0, ...next.splice(from, 1))
  save(next)
  announcement.value = tl(`${next[to]!.name}: position ${to + 1} of ${next.length}`, `${next[to]!.name} : position ${to + 1} sur ${next.length}`)
}
const { drag, shift, onGrab } = useRowDrag(list, move)
function step(id: string, delta: -1 | 1) {
  const at = proxies.value.findIndex(p => p.id === id)
  move(id, at + delta)
  nextTick(() => list.value?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"] .key-order-step:not(:disabled)`)?.focus())
}
function onKey(id: string, e: KeyboardEvent) {
  const at = proxies.value.findIndex(p => p.id === id)
  if (e.key === 'ArrowUp' && at > 0) move(id, at - 1)
  else if (e.key === 'ArrowDown' && at < proxies.value.length - 1) move(id, at + 1)
  else return
  e.preventDefault()
  nextTick(() => list.value?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"] .bar-pref-grip`)?.focus())
}

function edit(p?: ProxyEntry) {
  error.value = null
  editing.value = p
    ? { id: p.id, name: p.name, url: p.url, noProxy: p.noProxy || '', machines: [...(p.machines || [])] }
    : { name: '', url: '', noProxy: '', machines: [] }
}

function toggleMachine(key: string, on: boolean) {
  const d = editing.value
  if (!d) return
  d.machines = on ? [...new Set([...d.machines, key])] : d.machines.filter(k => k !== key)
}

// The whole list goes back at once (add, edit, delete and reorder all do);
// an untouched ••• mask in the url keeps the stored password on the server.
async function save(next: ProxyEntry[]) {
  busy.value = true
  try { await saveProxies(next); error.value = null }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}

async function saveDraft() {
  const d = editing.value
  if (!d) return
  const entry: ProxyEntry = {
    id: d.id || '',
    name: d.name.trim(), url: d.url.trim(),
    ...(d.noProxy.trim() ? { noProxy: d.noProxy.trim() } : {}),
    ...(d.machines.length ? { machines: d.machines } : {}),
  }
  const next = d.id ? proxies.value.map(p => p.id === d.id ? entry : p) : [...proxies.value, entry]
  await save(next)
  if (!error.value) editing.value = null
}

async function remove(p: ProxyEntry) {
  await save(proxies.value.filter(x => x.id !== p.id))
  if (editing.value?.id === p.id) editing.value = null
}
</script>

<template>
  <div class="settings-group" data-testid="proxies-settings">
    <h3>{{ t('Proxies') }}</h3>
    <p class="muted agent-pref-intro">{{ t('Offered in the “New” sheet: the agent’s environment gets the one picked, on the machine it starts on. A proxy is machine-relative: 127.0.0.1 names that machine’s own. A password stays on the server — the list shows user:•••@host:port, and an edit that leaves the mask keeps it.') }}</p>

    <ul v-if="proxies.length" ref="list" class="bar-pref-list" :class="{ dragging: drag }" :aria-label="t('Proxies')">
      <li
        v-for="(p, i) in proxies" :key="p.id" class="bar-pref-row" :class="{ moving: drag?.id === p.id }"
        :style="{ transform: shift(i) }" :data-row="p.id"
      >
        <button
          type="button" class="bar-pref-grip" :aria-label="tl(`Move ${p.name} — up and down arrows`, `Déplacer ${p.name} — flèches haut et bas`)"
          :title="t('Drag to reorder')" @pointerdown="onGrab(p.id, $event)" @keydown="onKey(p.id, $event)"
        >⠿</button>
        <div class="proxy-label">
          <b>{{ p.name }}</b>
          <small class="mono">{{ p.url }}</small>
          <small>{{ machineHint(p) }}</small>
        </div>
        <button type="button" class="key-order-step" :aria-label="tl(`Edit ${p.name}`, `Modifier ${p.name}`)" @click="edit(p)"><UIcon name="i-lucide-pencil" /></button>
        <button type="button" class="key-order-step" :aria-label="tl(`Delete ${p.name}`, `Supprimer ${p.name}`)" @click="remove(p)"><UIcon name="i-lucide-trash-2" /></button>
        <button
          type="button" class="key-order-step key-order-up" :disabled="i === 0"
          :aria-label="tl(`Move ${p.name} up`, `Monter ${p.name}`)" @click="step(p.id, -1)"
        ><UIcon name="i-lucide-chevron-up" /></button>
        <button
          type="button" class="key-order-step key-order-down" :disabled="i === proxies.length - 1"
          :aria-label="tl(`Move ${p.name} down`, `Descendre ${p.name}`)" @click="step(p.id, 1)"
        ><UIcon name="i-lucide-chevron-down" /></button>
      </li>
    </ul>
    <p v-else class="muted agent-pref-intro">{{ t('No proxy saved yet.') }}</p>
    <p class="key-order-announcement" aria-live="polite">{{ announcement }}</p>

    <form v-if="editing" class="proxy-form" data-testid="proxy-form" @submit.prevent="saveDraft">
      <label class="field-label" for="proxyName">{{ t('Name') }}</label>
      <UInput id="proxyName" v-model="editing.name" size="xl" class="w-full" maxlength="60" :placeholder="t('E.g. Office VPN')" data-testid="proxy-name" />
      <label class="field-label" for="proxyUrl">{{ t('URL') }}</label>
      <UInput
        id="proxyUrl" v-model="editing.url" size="xl" class="w-full mono" maxlength="512"
        autocapitalize="none" autocorrect="off" :spellcheck="false"
        placeholder="http://user:pass@host:port · socks5://host:1080" data-testid="proxy-url"
      />
      <small class="muted proxy-form-hint">{{ t('http://, https:// or socks5://, optionally user:pass@. Leave ••• as the password to keep the stored one.') }}</small>
      <label class="field-label" for="proxyNo">{{ t('Bypass for') }} <span class="muted">{{ t('(optional)') }}</span></label>
      <UInput
        id="proxyNo" v-model="editing.noProxy" size="xl" class="w-full mono" maxlength="1024"
        autocapitalize="none" autocorrect="off" :spellcheck="false"
        placeholder="localhost,127.0.0.1,.internal" data-testid="proxy-noproxy"
      />
      <template v-if="machineChoices">
        <label class="field-label">{{ t('Offered on') }}</label>
        <label v-for="m in machineChoices" :key="m.key" class="proxy-machine">
          <input type="checkbox" :checked="editing.machines.includes(m.key)" @change="toggleMachine(m.key, ($event.target as HTMLInputElement).checked)">
          <span>{{ machineLabel(m.key) }}</span>
        </label>
        <small class="muted proxy-form-hint">{{ t('None checked: offered on every machine.') }}</small>
      </template>
      <div class="proxy-form-actions">
        <UButton type="submit" color="primary" size="xl" :label="t('Save')" :loading="busy" :disabled="!editing.name.trim() || !editing.url.trim()" data-testid="proxy-save" />
        <UButton type="button" color="neutral" variant="ghost" size="xl" :label="t('Cancel')" @click="editing = null" />
      </div>
    </form>
    <p v-if="error" class="form-error">{{ t(error) }}</p>
    <UButton v-if="!editing" block color="neutral" variant="outline" size="xl" icon="i-lucide-plus" :label="t('Add a proxy')" class="proxy-add" data-testid="proxy-add" @click="edit()" />
  </div>
</template>

<style scoped>
.proxy-label { flex: 1; min-width: 0; display: grid; align-content: center; gap: 2px; padding: 8px 10px; }
.proxy-label b { font-size: 15px; font-weight: 600; color: var(--text); }
.proxy-label small { overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.proxy-label small.mono { font-family: var(--mono); }
.proxy-form { margin-top: 14px; padding: 12px; border: 1px solid var(--line); background: var(--bg-2); display: grid; gap: 4px; }
.proxy-form .field-label { margin-top: 10px; }
.proxy-form .field-label:first-child { margin-top: 0; }
.proxy-form-hint { display: block; margin: 4px 2px 0; font-size: 12px; }
.proxy-machine { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 4px 10px; }
.proxy-machine input { width: 20px; height: 20px; accent-color: var(--accent); }
.proxy-form-actions { display: flex; gap: 8px; margin-top: 14px; }
.proxy-add { margin-top: 14px; }
</style>
