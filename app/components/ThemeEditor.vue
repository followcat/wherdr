<script setup lang="ts">
// Custom theme editor (Settings › Appearance): start from any theme, change
// its colors for Dark and Light with a live preview and the WCAG AA contrast
// check; a custom theme is also duplicated, exported or deleted here.
import type { ThemeColors, ThemeDef } from '~/utils/themes'
import { newCustomId, themeFile } from '~/utils/customThemes'

const open = defineModel<boolean>('open', { default: false })
// The theme opened: a custom one is edited, any other is the starting point of a new one.
const props = defineProps<{ base: ThemeDef | null }>()

const draft = ref<ThemeDef | null>(null)
const editing = computed(() => props.base?.group === 'custom')
const light = ref(false)
const copy = (th: ThemeDef, asNew: boolean): ThemeDef => ({
  ...th, id: asNew ? newCustomId() : th.id, group: 'custom', label: asNew ? tl(`${th.label} copy`) : th.label,
  c: { ...th.c }, light: { ...th.light }, ansi: [...th.ansi],
})
watch(open, (o) => {
  if (!o || !props.base) return
  draft.value = copy(props.base, !editing.value)
  light.value = activeTheme.value.light
}, { immediate: true })
const startItems = computed(() => [...THEMES, ...customThemes.value].map(th => ({ label: th.label, value: th.id })))
function startFrom(id: string) {
  const th = findTheme(id)
  if (th && draft.value) draft.value = { ...copy(th, true), id: draft.value.id }
}

const FIELDS: [keyof ThemeColors, string][] = [
  ['bg', 'Background'], ['bg2', 'Sidebar'], ['surface', 'Surface'], ['line', 'Borders'], ['text', 'Text'], ['muted', 'Muted text'],
  ['accent', 'Accent'], ['green', 'Success'], ['ochre', 'Warning'], ['rose', 'Danger'],
]
const palette = computed(() => (light.value ? draft.value!.light : draft.value!.c))
const variant = computed(() => themeVariant(draft.value!, light.value))
const issues = computed(() => contrastIssues(variant.value.c))
const modes = computed(() => [{ value: false, label: t('Dark') }, { value: true, label: t('Light') }])

const fileName = computed(() => `${(draft.value?.label || 'theme').replace(/[^\w-]+/g, '-').toLowerCase()}.wherdr-theme.json`)
const json = () => JSON.stringify(themeFile(draft.value!), null, 2)
function download() {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' }))
  a.download = fileName.value
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
}
function save() {
  if (!draft.value?.label.trim()) return
  if (saveCustomTheme({ ...draft.value, label: draft.value.label.trim().slice(0, 40), author: draft.value.author?.trim().slice(0, 60) || undefined })) open.value = false
}
function duplicate() {
  if (saveCustomTheme(copy(draft.value!, true))) open.value = false
}
async function remove() {
  if (!(await askConfirm(tl(`Delete the theme ${draft.value!.label}?`), tl('Delete')))) return
  deleteCustomTheme(draft.value!.id)
  open.value = false
}
</script>

<template>
  <AppSheet v-model:open="open" :title="editing ? tl('Edit theme') : tl('Create theme')" tall wide hide-close>
    <div v-if="draft" class="te" data-testid="theme-editor">
      <template v-if="!editing">
        <label class="field-label" for="teStart">{{ tl('Start from') }}</label>
        <USelect id="teStart" :model-value="base?.id" :items="startItems" size="xl" class="w-full" @update:model-value="v => startFrom(String(v))" />
      </template>
      <div class="te-names">
        <span><label class="field-label" for="teName">{{ tl('Name') }}</label><UInput id="teName" v-model="draft.label" size="xl" class="w-full" maxlength="40" data-testid="theme-name" /></span>
        <span><label class="field-label" for="teAuthor">{{ tl('Author (optional)') }}</label><UInput id="teAuthor" v-model="draft.author" size="xl" class="w-full" maxlength="60" /></span>
      </div>
      <div class="segmented" role="radiogroup" :aria-label="t('Mode')" style="--segment-count: 2">
        <button v-for="m in modes" :key="m.label" type="button" role="radio" :class="{ on: light === m.value }" :aria-checked="light === m.value" @click="light = m.value">{{ m.label }}</button>
      </div>
      <div class="te-body">
        <div class="te-fields">
          <label v-for="[key, label] in FIELDS" :key="key" class="te-color">
            <input v-model="palette[key]" type="color" :data-color="key"><span>{{ tl(label) }}<small class="mono">{{ palette[key] }}</small></span>
          </label>
          <template v-if="!light">
            <h4 class="field-label">{{ tl('Terminal colors') }}</h4>
            <div class="te-ansi">
              <input v-for="(_, i) in draft.ansi" :key="i" v-model="draft.ansi[i]" type="color" :aria-label="tl(`Terminal color ${i + 1}`)">
            </div>
          </template>
        </div>
        <div>
          <div class="te-preview" :style="themeVars(variant)" data-testid="theme-preview">
            <div class="te-row"><i class="te-sq working" /><b>api-server</b><small>{{ tl('Working') }}</small></div>
            <div class="te-row"><i class="te-sq blocked" /><b>docs</b><small>{{ tl('Your turn') }}</small></div>
            <p class="te-user">{{ tl('Can you fix the failing test?') }}</p>
            <p>{{ tl('Fixed: the date was parsed in the wrong time zone.') }}</p>
            <div class="te-actions"><span class="te-btn">{{ tl('Send') }}</span><span class="te-badge">{{ tl('Done') }}</span></div>
          </div>
          <p v-if="issues.length" class="te-check warn" role="status" data-testid="theme-contrast">
            <UIcon name="i-lucide-triangle-alert" /> {{ tl('Below WCAG AA:') }} {{ issues.join(', ') }}
          </p>
          <p v-else class="te-check" role="status" data-testid="theme-contrast"><UIcon name="i-lucide-check" /> {{ tl('Contrast meets WCAG AA') }}</p>
        </div>
      </div>
    </div>
    <template #footer>
      <div v-if="draft" class="te-foot">
        <template v-if="editing">
          <UButton size="lg" color="neutral" variant="outline" icon="i-lucide-download" @click="download">{{ tl('Export') }}</UButton>
          <UButton size="lg" color="neutral" variant="outline" icon="i-lucide-copy" @click="copyCode(json())">{{ tl('Copy JSON') }}</UButton>
          <UButton size="lg" color="neutral" variant="outline" icon="i-lucide-copy-plus" @click="duplicate">{{ tl('Duplicate') }}</UButton>
          <UButton size="lg" color="error" variant="outline" icon="i-lucide-trash-2" @click="remove">{{ tl('Delete') }}</UButton>
        </template>
        <UButton size="xl" color="primary" class="hw-cta" :disabled="!draft.label.trim()" data-testid="theme-save" @click="save">{{ tl('Save theme') }}</UButton>
      </div>
    </template>
  </AppSheet>
</template>

<style scoped>
.te { display: grid; gap: 12px; min-width: 0; }
.te-names { display: grid; gap: 12px; }
.te-body { display: grid; gap: 16px; min-width: 0; }
.te-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; align-content: start; }
.te-fields .field-label { grid-column: 1 / -1; margin-top: 8px; }
.te-color { display: flex; align-items: center; gap: 8px; min-height: 44px; min-width: 0; }
.te-color span { display: grid; min-width: 0; overflow-wrap: anywhere; }
.te-color small { color: var(--muted); font-size: 11px; }
input[type="color"] { flex: none; width: 44px; height: 44px; padding: 2px; border: 1px solid var(--line); background: var(--bg); }
.te-ansi { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(8, minmax(0, 44px)); gap: 4px; }
.te-ansi input { width: 100%; }
.te-preview { display: grid; gap: 8px; padding: 12px; background: var(--bg); color: var(--text); border: 1px solid var(--line); }
.te-row { display: flex; align-items: center; gap: 8px; padding: 8px; background: var(--surface); border: 1px solid var(--line-soft); }
.te-row small { margin-left: auto; color: var(--muted); }
.te-sq { width: 7px; height: 7px; flex: none; }
.te-sq.working { background: var(--working); }
.te-sq.blocked { background: var(--blocked); }
.te-preview p { margin: 0; }
.te-user { justify-self: end; padding: 6px 10px; background: var(--surface-2); }
.te-actions { display: flex; align-items: center; gap: 8px; }
.te-btn { padding: 8px 14px; background: var(--accent); color: var(--on-accent); font-weight: 600; }
.te-badge { padding: 2px 6px; border: 1px solid var(--done); color: var(--done); font: 500 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .12em; }
.te-check { margin: 8px 0 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.te-check.warn { color: var(--ochre); }
.te-foot { display: flex; flex-wrap: wrap; gap: 8px; }
.te-foot .hw-cta { flex: 1 1 100%; }
@media (min-width: 900px) {
  .te-names { grid-template-columns: 1fr 1fr; }
  .te-body { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
</style>
