<script setup lang="ts">
// Settings › Projects › Template library: the saved templates and the
// built-in examples. Tap one to read it (each task type's plan, then its
// JSON); a saved one is renamed or deleted from its ⋯ menu. A project never
// follows the library: it starts from a copy (New sheet, or Workflow › ⋯).
import { EXAMPLES } from '#shared/pm/examples'
import { planSteps } from '#shared/pm/steps'
import type { TemplateInfo } from '#shared/pm/project'
import type { Template } from '#shared/pm/workflow'

const props = defineProps<{ templates: TemplateInfo[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [] }>()

const examples = computed(() => EXAMPLES.filter(e => !props.templates.some(t => t.id === e.id)))
// The one being read: a saved id, or example:<id>.
const shown = ref('')
const template = ref<Template | null>(null)
const renaming = ref(false)
const newId = ref('')
const busy = ref(false)
const error = ref('')
const saved = computed(() => !!shown.value && !shown.value.startsWith('example:'))
const name = computed(() => shown.value.replace(/^example:/, ''))
watch(open, (o) => { if (!o) back() })

async function view(id: string) {
  shown.value = id
  template.value = null
  error.value = ''
  const ex = EXAMPLES.find(e => `example:${e.id}` === id)
  try { template.value = ex ?? (await api<{ template: Template }>(`/api/pm/template?id=${encodeURIComponent(id)}`)).template }
  catch (e) { error.value = (e as Error).message }
}
function back() { shown.value = ''; template.value = null; renaming.value = false; error.value = '' }
const plans = computed(() => (template.value ? Object.keys(template.value.taskTypes).map(type => ({ type, steps: planSteps(template.value!, { type }) })) : []))

async function run(fn: () => Promise<unknown>) {
  if (busy.value) return false
  busy.value = true
  error.value = ''
  try { await fn(); emit('changed'); return true }
  catch (e) { error.value = (e as Error).message; return false }
  finally { busy.value = false }
}
async function rename() {
  const to = newId.value.trim()
  if (await run(() => api('/api/pm/template-rename', { id: name.value, to }))) { toast(tl(`Renamed to ${to}`)); back() }
}
async function remove() {
  if (!(await askConfirm(tl(`Delete template ${name.value}? Projects started from it keep their own workflow.`), tl('Delete')))) return
  if (await run(() => api('/api/pm/template-remove', { id: name.value }))) { toast(tl(`Template ${name.value} deleted`)); back() }
}
const menu = (): MenuItem[] => [
  { label: tl('Rename…'), icon: 'i-lucide-pencil', run: () => { newId.value = name.value; renaming.value = true } },
  { label: tl(`Delete ${name.value}`), icon: 'i-lucide-trash-2', danger: true, run: remove },
]
</script>

<template>
  <AppSheet v-model:open="open" :title="shown ? name : tl('Template library')" tall wide hide-close>
    <div class="library" data-testid="template-library">
      <template v-if="!shown">
        <small class="muted">{{ tl('A project starts from a copy of a template: changing or deleting one here never changes a project.') }}</small>
        <h4 class="mono-label">{{ tl('Saved') }}</h4>
        <div v-if="templates.length" class="settings-card library-list">
          <button v-for="tp in templates" :key="tp.id" type="button" class="library-row" data-testid="library-saved" :data-id="tp.id" @click="view(tp.id)">
            <b class="mono">{{ tp.id }}</b><small class="mono-label">v{{ tp.version ?? 1 }}</small>
            <UIcon name="i-lucide-chevron-right" class="library-chevron" />
          </button>
        </div>
        <p v-else class="muted settings-hint">{{ tl('None yet: save a project\'s workflow with Workflow › ⋯ › Save as template.') }}</p>
        <h4 class="mono-label">{{ tl('Examples') }}</h4>
        <div class="settings-card library-list">
          <button v-for="e in examples" :key="e.id" type="button" class="library-row" data-testid="library-example" :data-id="e.id" @click="view(`example:${e.id}`)">
            <b class="mono">{{ e.id }}</b><small class="mono-label">{{ tl('Example') }}</small>
            <UIcon name="i-lucide-chevron-right" class="library-chevron" />
          </button>
        </div>
      </template>
      <template v-else>
        <div class="library-head">
          <UButton color="neutral" variant="ghost" size="lg" icon="i-lucide-chevron-left" data-testid="library-back" @click="back">{{ tl('Template library') }}</UButton>
          <SpaceMenu v-if="saved" :items="menu" :title="name" :label="tl(`Options of ${name}`)" />
        </div>
        <form v-if="renaming" class="sheet-form" @submit.prevent="rename">
          <label class="field-label" for="libNewId">{{ tl('New id') }}</label>
          <UInput id="libNewId" v-model="newId" size="xl" class="w-full mono" maxlength="60" data-testid="library-new-id" />
          <UButton type="submit" size="xl" color="primary" class="hw-cta" :loading="busy" :disabled="!newId.trim() || busy" data-testid="library-rename">{{ tl('Rename') }}</UButton>
        </form>
        <template v-if="template">
          <small class="muted">{{ saved ? tl(`Version ${template.version ?? 1}. Read only: change a project's own workflow, then save it as a template.`) : tl('A built-in example, read only.') }}</small>
          <section v-for="pl in plans" :key="pl.type" data-testid="library-plan">
            <h4 class="mono-label">{{ tl(`Plan of a ${pl.type} task`) }}</h4>
            <ol class="library-plan">
              <li v-for="s in pl.steps" :key="s.id"><b class="mono">{{ s.id }}</b> <span class="muted">{{ s.column || s.id }} · {{ s.holder || 'none' }}{{ s.ends ? ` → ${s.ends}` : '' }}</span></li>
            </ol>
          </section>
          <h4 class="mono-label">JSON</h4>
          <pre class="library-json" data-testid="library-json">{{ JSON.stringify(template, null, 2) }}</pre>
        </template>
      </template>
      <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
    </div>
  </AppSheet>
</template>

<style scoped>
.library { display: grid; gap: 12px; }
.library h4 { margin: 8px 0 0; }
.library-list { padding: 0; }
.library-row { display: flex; width: 100%; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); text-align: left; }
.library-row:last-child { border-bottom: 0; }
.library-row:active { background: var(--surface-2); }
.library-row b { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.library-chevron { flex: none; color: var(--muted); }
.library-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.library-plan { display: grid; gap: 4px; margin: 0; padding: 0; list-style: decimal inside; overflow-wrap: anywhere; }
.library-json { margin: 0; max-height: 50vh; overflow: auto; padding: 8px; border: 1px solid var(--line); background: var(--bg); font: 12px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
