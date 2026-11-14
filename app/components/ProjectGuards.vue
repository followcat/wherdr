<script setup lang="ts">
// The project sheet's Guards tab: the protected branches as chips with an add
// field, who merges into protected and other branches, and what that does
// (guardEffects: what each task type adds, who merges at each step). Saved
// through project-guards, which only the user or Alfred may call.
import { guardEffects } from '#shared/pm/guardEffects'
import type { Project } from '#shared/pm/project'
import type { Guards, MergeBy, Template } from '#shared/pm/workflow'
import { DEFAULT_MERGE } from '#shared/pm/guards'

const props = defineProps<{ project: Project, workflow: Template }>()
const emit = defineEmits<{ changed: [] }>()

const form = reactive({ protected: [] as string[], merge: { ...DEFAULT_MERGE } })
const adding = ref('')
const busy = ref(false)
const error = ref('')
const reset = (g: Guards = {}) => Object.assign(form, { protected: [...(g.protected ?? [])], merge: { ...DEFAULT_MERGE, ...g.merge } })
watch(() => props.workflow.guards, g => reset(g), { immediate: true })

// The guards the form says, keeping what it does not show (contributorPrs).
const draft = computed<Guards>(() => ({ ...props.workflow.guards, protected: [...form.protected], merge: { ...form.merge } }))
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify({ ...props.workflow.guards, protected: props.workflow.guards?.protected ?? [], merge: { ...DEFAULT_MERGE, ...props.workflow.guards?.merge } }))
const effects = computed(() => guardEffects(props.workflow, draft.value, props.project.base))

function add() {
  const b = adding.value.trim()
  if (b && !form.protected.includes(b)) form.protected.push(b)
  adding.value = ''
}
const drop = (b: string) => { form.protected = form.protected.filter(x => x !== b) }

const WHO: { value: MergeBy, label: string }[] = [{ value: 'user', label: 'You' }, { value: 'engine', label: 'wherdr' }]
const ROWS = [{ k: 'protected', label: 'Who merges into protected branches' }, { k: 'others', label: 'Who merges other branches' }] as const
const who = (m: MergeBy) => (m === 'user' ? tl('you') : 'wherdr')
const typeLine = (e: ReturnType<typeof guardEffects>['types'][number]) => [
  ...(e.protects.length ? [tl(`also protects ${e.protects.join(', ')}`)] : []),
  ...(e.merge.protected ? [tl(`merge into protected branches → ${who(e.merge.protected)}`)] : []),
  ...(e.merge.others ? [tl(`merge into other branches → ${who(e.merge.others)}`)] : []),
].join(' · ')

async function save() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api('/api/pm/project-guards', { key: props.project.key, guards: draft.value })
    emit('changed')
    toast(tl('Guards saved'))
  }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <form class="sheet-form" data-testid="project-guards" @submit.prevent="save">
    <span class="field-label">{{ tl('Protected branches') }}</span>
    <div class="guard-chips">
      <span v-for="b in form.protected" :key="b" class="guard-chip mono" data-testid="guard-chip">
        {{ b }}
        <button type="button" :aria-label="tl(`Unprotect ${b}`)" @click="drop(b)"><UIcon name="i-lucide-x" /></button>
      </span>
      <small v-if="!form.protected.length" class="muted">{{ tl('No branch is protected.') }}</small>
    </div>
    <span class="guard-add">
      <UInput v-model="adding" size="lg" class="mono" :placeholder="tl('Add a branch')" :aria-label="tl('Branch to protect')" maxlength="200" data-testid="guard-add" @keydown.enter.prevent="add" />
      <UButton size="lg" color="neutral" variant="outline" icon="i-lucide-plus" :disabled="!adding.trim()" data-testid="guard-add-button" @click="add">{{ tl('Add') }}</UButton>
    </span>

    <template v-for="r in ROWS" :key="r.k">
      <span class="field-label pm-later">{{ tl(r.label) }}</span>
      <div class="segmented" role="radiogroup" :aria-label="tl(r.label)" style="--segment-count: 2">
        <button v-for="w in WHO" :key="w.value" type="button" role="radio" :aria-checked="form.merge[r.k] === w.value" :class="{ on: form.merge[r.k] === w.value }" :data-testid="`guard-${r.k}-${w.value}`" @click="form.merge[r.k] = w.value">
          <span>{{ w.value === 'user' ? tl(w.label) : w.label }}</span>
        </button>
      </div>
    </template>

    <span class="field-label pm-later">{{ tl('Effect') }}</span>
    <ul class="guard-effects" data-testid="guard-effects">
      <li v-for="e in effects.types" :key="`t-${e.type}`"><b class="mono">{{ e.type }}</b> · <span class="muted">{{ typeLine(e) }}</span></li>
      <li v-for="e in effects.steps" :key="`s-${e.type}-${e.step}`">
        <b class="mono">{{ e.type }}</b> · <span class="muted">{{ e.step }} · {{ tl(`merge into ${e.into}`) }} →</span>&nbsp;<span :class="{ 'guard-you': e.by === 'user' }">{{ e.by === 'user' ? tl('left to you') : 'wherdr' }}</span>
      </li>
      <li v-if="!effects.types.length && !effects.steps.length" class="muted">{{ tl('No step merges a branch.') }}</li>
    </ul>

    <UButton type="submit" size="xl" color="primary" variant="solid" class="hw-cta" icon="i-lucide-save" :loading="busy" :disabled="!dirty || busy" data-testid="guard-save">{{ tl('Save guards') }}</UButton>
    <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
  </form>
</template>

<style scoped>
.guard-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.guard-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 4px 4px 10px; border: 1px solid var(--line); font-size: 13px; }
.guard-chip button { position: relative; display: grid; place-items: center; width: 32px; height: 32px; color: var(--muted); }
.guard-chip button::after { content: ''; position: absolute; inset: -6px; }
.guard-chip button:hover { color: var(--text); }
.guard-add { display: flex; gap: 8px; }
.guard-add > :first-child { flex: 1; min-width: 0; max-width: 320px; }
.pm-later { margin-top: 18px; }
.guard-effects { display: grid; gap: 6px; margin-bottom: 12px; font-size: 13px; overflow-wrap: anywhere; }
.guard-you { color: var(--ochre); }
</style>
