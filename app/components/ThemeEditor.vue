<script setup lang="ts">
// Custom theme editor (Settings › Appearance): start from any theme, change
// its colors for Dark and Light with a live preview and the WCAG AA contrast
// check (ThemeSample: the whole app in miniature), or as its JSON file (the JSON
// tab, checked like an import); a custom theme is also duplicated, exported or deleted here.
import type { ThemeColors, ThemeDef } from '~/utils/themes'
import { importThemeText, newCustomId, themeErrorLine, themeFile } from '~/utils/customThemes'

const open = defineModel<boolean>('open', { default: false })
// The theme opened: a custom one is edited, any other is the starting point of a new one.
const props = defineProps<{ base: ThemeDef | null }>()

const draft = ref<ThemeDef | null>(null)
// Editing a saved custom theme; any other (a built-in one, a theme Alfred proposed) starts a new one.
const editing = computed(() => !!props.base && customThemes.value.some(t => t.id === props.base!.id))
const light = ref(false)
type Tab = 'dark' | 'light' | 'json'
const tab = ref<Tab>('dark')
function pick(v: Tab) {
  tab.value = v
  if (v !== 'json') light.value = v === 'light'
}
const copy = (th: ThemeDef, asNew: boolean): ThemeDef => ({
  ...th, id: asNew ? newCustomId() : th.id, group: 'custom', label: asNew && findTheme(th.id) ? tl(`${th.label} copy`) : th.label,
  c: { ...th.c }, light: { ...th.light }, ansi: [...th.ansi],
})
watch(open, (o) => {
  if (!o || !props.base) return
  draft.value = copy(props.base, !editing.value)
  pick(activeTheme.value.light ? 'light' : 'dark')
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
const modes = computed<{ value: Tab, label: string }[]>(() => [{ value: 'dark', label: t('Dark') }, { value: 'light', label: t('Light') }, { value: 'json', label: 'JSON' }])

const fileName = computed(() => `${(draft.value?.label || 'theme').replace(/[^\w-]+/g, '-').toLowerCase()}.wherdr-theme.json`)
const json = () => JSON.stringify(themeFile(draft.value!), null, 2)

// The JSON tab: a valid edit becomes the draft (swatches and preview follow);
// an invalid one keeps the last valid draft, says why and blocks Save.
const jsonText = ref('')
const jsonError = ref('')
const jsonLine = ref<number>()
let applied = '' // the draft's JSON as last applied from the text, kept as typed
watch(draft, (d) => {
  if (!d || json() === applied) return
  jsonText.value = json()
  jsonError.value = ''
}, { deep: true, immediate: true })
function editJson(text: string) {
  jsonText.value = text
  const th = importThemeText(text, draft.value!.id)
  if (typeof th === 'string') {
    jsonError.value = th
    jsonLine.value = themeErrorLine(text, th)
    return
  }
  jsonError.value = ''
  applied = JSON.stringify(themeFile(th), null, 2)
  draft.value = th
}
function download() {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' }))
  a.download = fileName.value
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
}
function save() {
  if (!draft.value?.label.trim() || jsonError.value) return
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
        <USelect id="teStart" :model-value="findTheme(base?.id) ? base?.id : undefined" :placeholder="tl('Choose a theme')" :items="startItems" size="xl" class="w-full" @update:model-value="v => startFrom(String(v))" />
      </template>
      <div class="te-names">
        <span><label class="field-label" for="teName">{{ tl('Name') }}</label><UInput id="teName" v-model="draft.label" size="xl" class="w-full" maxlength="40" data-testid="theme-name" /></span>
        <span><label class="field-label" for="teAuthor">{{ tl('Author (optional)') }}</label><UInput id="teAuthor" v-model="draft.author" size="xl" class="w-full" maxlength="60" /></span>
      </div>
      <div class="segmented" role="radiogroup" :aria-label="t('Mode')" style="--segment-count: 3">
        <button v-for="m in modes" :key="m.value" type="button" role="radio" :class="{ on: tab === m.value }" :aria-checked="tab === m.value" :data-testid="`theme-tab-${m.value}`" @click="pick(m.value)">{{ m.label }}</button>
      </div>
      <p v-if="jsonError" class="form-error" role="alert" data-testid="theme-json-error">{{ jsonLine ? `${tl('Line')} ${jsonLine}: ` : '' }}{{ tl(jsonError) }}</p>
      <div class="te-body">
        <div v-if="tab === 'json'" class="te-json">
          <UTextarea :model-value="jsonText" :rows="18" size="lg" class="w-full mono" :aria-label="tl('Theme JSON')" spellcheck="false" autocapitalize="off" autocomplete="off" data-testid="theme-json" @update:model-value="v => editJson(String(v))" />
        </div>
        <div v-else class="te-fields">
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
        <ThemeSample :variant="variant" full />
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
        <UButton size="xl" color="primary" class="hw-cta" :disabled="!draft.label.trim() || !!jsonError" data-testid="theme-save" @click="save">{{ tl('Save theme') }}</UButton>
      </div>
    </template>
  </AppSheet>
</template>

<style scoped>
.te { display: grid; gap: 12px; min-width: 0; }
.te-names { display: grid; gap: 12px; }
.te-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; }
.te-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; align-content: start; }
.te-fields .field-label { grid-column: 1 / -1; margin-top: 8px; }
.te-color { display: flex; align-items: center; gap: 8px; min-height: 44px; min-width: 0; }
.te-color span { display: grid; min-width: 0; overflow-wrap: anywhere; }
.te-color small { color: var(--muted); font-size: 11px; }
input[type="color"] { flex: none; width: 44px; height: 44px; padding: 2px; border: 1px solid var(--line); background: var(--bg); }
.te-ansi { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(8, minmax(0, 44px)); gap: 4px; }
.te-ansi input { width: 100%; }
.te-json { min-width: 0; }
.te-json :deep(textarea) { white-space: pre; overflow: auto; overflow-wrap: normal; }
.te-foot { display: flex; flex-wrap: wrap; gap: 8px; }
.te-foot .hw-cta { flex: 1 1 100%; }
@media (min-width: 900px) {
  .te-names { grid-template-columns: 1fr 1fr; }
  .te-body { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
</style>
