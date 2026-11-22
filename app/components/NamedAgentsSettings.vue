<script setup lang="ts">
// Settings › Agents › Named agents: a name for a command (a wrapper script and
// fixed options) on some machines, that workflow prefs may name instead of a
// program (shared/pm/namedAgents.ts). Synced; never a secret.
import { PROGRAMS } from '#shared/pm/workflow'
import { namedAgentError, type NamedAgent } from '#shared/pm/namedAgents'

const machines = computed(() => appConfig.value.machines?.map(m => ({ key: m.key, label: m.label || t('This machine') }))
  ?? [{ key: '', label: hostLabel.value || t('This machine') }])
const machineLabel = (key: string) => machines.value.find(m => m.key === key)?.label ?? key
const programItems = PROGRAMS.map(p => ({ label: kindLabel(p), value: p as string }))

// The agent being edited (editing: its name before, '' for a new one), or none.
const form = ref<NamedAgent | null>(null)
const editing = ref('')
const error = ref('')
function open(a?: NamedAgent) {
  form.value = a ? { ...a, machines: [...a.machines] } : { name: '', program: 'claude', command: '', machines: machines.value.length === 1 ? [machines.value[0]!.key] : [] }
  editing.value = a?.name ?? ''
  error.value = ''
}
function toggleMachine(key: string, on: boolean) {
  const f = form.value!
  f.machines = on ? [...new Set([...f.machines, key])] : f.machines.filter(k => k !== key)
}
function save() {
  const f = form.value!
  const a = { ...f, name: f.name.trim(), command: f.command.trim() }
  const others = namedAgents.value.filter(x => x.name !== editing.value)
  const why = namedAgentError(a, others.map(x => x.name))
  if (why) return void (error.value = why)
  namedAgents.value = editing.value ? namedAgents.value.map(x => (x.name === editing.value ? a : x)) : [...namedAgents.value, a]
  form.value = null
  haptic()
}
function remove(name: string) {
  namedAgents.value = namedAgents.value.filter(x => x.name !== name)
  if (editing.value === name) form.value = null
}
</script>

<template>
  <div class="settings-group" data-testid="named-agents">
    <h3>{{ t('Named agents') }}</h3>
    <p class="muted agent-pref-intro">{{ t('A name for a command on some machines: a wrapper script on the PATH and its fixed options, such as another account of the same program. A workflow names it in prefs.agent. Keep keys in the script, never here.') }}</p>
    <ul v-if="namedAgents.length" class="bar-pref-list agent-pref-list" :aria-label="t('Named agents')">
      <li v-for="a in namedAgents" :key="a.name" class="bar-pref-row named-agent-row" :data-row="a.name">
        <span class="agent-pref-name">
          <b>{{ a.name }}</b>
          <small class="mono">{{ a.command }}</small>
          <small>{{ kindLabel(a.program) }} · {{ a.machines.map(machineLabel).join(', ') }}</small>
        </span>
        <UButton color="neutral" variant="ghost" size="lg" icon="i-lucide-pencil" class="named-agent-btn" :aria-label="`${t('Edit')} ${a.name}`" @click="open(a)" />
        <UButton color="neutral" variant="ghost" size="lg" icon="i-lucide-trash-2" class="named-agent-btn" :aria-label="`${t('Remove')} ${a.name}`" @click="remove(a.name)" />
      </li>
    </ul>
    <form v-if="form" class="named-agent-form" data-testid="named-agent-form" @submit.prevent="save">
      <label class="named-agent-field">
        <span>{{ t('Name') }}</span>
        <UInput v-model="form.name" size="lg" class="mono w-full" placeholder="omp-sub" autocomplete="off" autocapitalize="none" autocorrect="off" :spellcheck="false" data-testid="named-agent-name" />
      </label>
      <label class="named-agent-field">
        <span>{{ t('Program') }}</span>
        <USelect v-model="form.program" :items="programItems" size="lg" class="w-full" data-testid="named-agent-program" />
        <small class="muted">{{ t('wherdr reads its conversation, choices and status as this program\'s.') }}</small>
      </label>
      <label class="named-agent-field">
        <span>{{ t('Command') }}</span>
        <UInput v-model="form.command" size="lg" class="mono w-full" placeholder="omp-sub --thinking medium" autocomplete="off" autocapitalize="none" autocorrect="off" :spellcheck="false" data-testid="named-agent-command" />
        <small class="muted">{{ t('wherdr adds the model, folders and first message after it.') }}</small>
      </label>
      <fieldset class="named-agent-field">
        <legend>{{ t('Machines that have it') }}</legend>
        <label v-for="m in machines" :key="m.key" class="named-agent-machine">
          <input type="checkbox" class="agent-pref-check" :checked="form.machines.includes(m.key)" @change="toggleMachine(m.key, ($event.target as HTMLInputElement).checked)">
          <span>{{ m.label }}</span>
        </label>
      </fieldset>
      <p v-if="error" class="named-agent-error" role="alert">{{ error }}</p>
      <div class="named-agent-actions">
        <UButton type="submit" color="primary" size="lg" :label="t('Save')" data-testid="named-agent-save" />
        <UButton color="neutral" variant="ghost" size="lg" :label="t('Cancel')" @click="form = null" />
      </div>
    </form>
    <UButton v-else color="neutral" variant="outline" size="lg" icon="i-lucide-plus" class="named-agent-add" data-testid="named-agent-add" :label="t('Add named agent')" @click="open()" />
  </div>
</template>

<style scoped>
.named-agent-row { padding: 6px 4px 6px 12px; }
.agent-pref-name { display: grid; flex: 1; min-width: 0; }
.agent-pref-name b { font-size: 15px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.agent-pref-name small { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.named-agent-btn { flex: none; min-width: 44px; min-height: 44px; justify-content: center; }
.named-agent-form { display: grid; gap: 14px; margin-top: 12px; }
.named-agent-field { display: grid; gap: 6px; min-width: 0; border: 0; padding: 0; margin: 0; }
.named-agent-field > span, .named-agent-field > legend { font-size: 13px; font-weight: 600; color: var(--text); padding: 0; }
.named-agent-field small { font-size: 12px; }
.named-agent-machine { display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; overflow-wrap: anywhere; }
.named-agent-error { color: var(--danger); font-size: 13px; }
.named-agent-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.named-agent-add { margin-top: 12px; }
</style>
