<script setup lang="ts">
// Model selector, in the footer of the input bar (like the Nuxt UI
// UChatPrompt examples). Shows the agent's current model; the options
// come from the agent's real /model menu (read by the server, then cached).
// The change only applies to this agent session. Unavailable when
// the agent is working or waiting for an answer.
// `launch` (the Board's Start): no session yet; the models and levels a program
// takes on a machine (`herdr-projects models`), picked for this start only
// (v-model:model, v-model:effort). None picked: the program alone, as before.
import type { EffortList, ModelInfo, ModelList, ModelOption, Pane } from '#shared/types'
import { type StartModels, effortsFor } from '#shared/projectsTasks'
import { currentModelOption } from '~/utils/modelSelection'

const props = defineProps<{ pane?: Pane, launch?: { machine: string, program: string } }>()
const launchModel = defineModel<string | null>('model', { default: null })
const launchEffort = defineModel<string | null>('effort', { default: null })

const modelOpen = ref(false)
const effortOpen = ref(false)
const modelsLoading = ref(false)
const effortsLoading = ref(false)
const switching = ref(false)
const list = ref<ModelList | null>(null)
const efforts = ref<EffortList | null>(null)
// Choice just made: shown until the server state has picked it up.
const chosen = ref<{ info: ModelInfo, at: number } | null>(null)

const baseName = (s: string | null | undefined) => String(s || '').trim().toLowerCase()
const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b) && baseName(a) === baseName(b)

const model = computed<ModelInfo | null>(() => {
  if (!props.pane) return null
  const c = chosen.value
  if (c && Date.now() - c.at < 20000 && (!same(props.pane!.model?.label, c.info.label) || props.pane!.model?.effort !== c.info.effort)) return c.info
  const info = props.pane!.model
  return info ? { ...info, effort: info.effort || efforts.value?.current || null } : null
})
watch(() => [props.pane?.model?.label, props.pane?.model?.effort], () => {
  if (props.pane && chosen.value && same(props.pane!.model?.label, chosen.value.info.label) && props.pane!.model?.effort === chosen.value.info.effort) chosen.value = null
})

const why = computed(() => {
  if (props.launch) return null
  if (!eventsOpen.value || offlineView.value || paneStale(props.pane)) return t('Changes unavailable offline')
  const s = props.pane!.status
  if (s === 'working') return t('The agent is working — change the model once it’s done.')
  if (s === 'blocked') return t('The agent is waiting for an answer — reply first.')
  return null
})
const locked = computed(() => Boolean(why.value) || switching.value)

async function loadModels(refresh = false) {
  if (modelsLoading.value) return
  modelsLoading.value = true
  try {
    list.value = await api<ModelList>(`/api/models?pane=${encodeURIComponent(props.pane!.id)}${refresh ? '&refresh=1' : ''}`)
  } catch (err) {
    modelOpen.value = false
    toast((err as Error).message, true)
  } finally {
    modelsLoading.value = false
  }
}
async function loadEfforts() {
  if (effortsLoading.value) return
  effortsLoading.value = true
  try {
    efforts.value = await api<EffortList>(`/api/efforts?pane=${encodeURIComponent(props.pane!.id)}`)
  } catch (err) {
    effortOpen.value = false
    toast((err as Error).message, true)
  } finally { effortsLoading.value = false }
}
watch(modelOpen, (o) => {
  if (props.launch) return
  if (o && (!list.value || list.value.agent !== props.pane!.agent)) loadModels()
})
watch(effortOpen, (o) => { if (o && !efforts.value && !props.launch) loadEfforts() })
watch(() => [eventsOpen.value, props.pane?.status, props.pane?.model?.label, props.pane?.model?.effort], () => {
  if (props.pane && ['claude', 'codex', 'omp'].includes(props.pane!.agent || '') && ['idle', 'done'].includes(props.pane!.status || '') &&
      !props.pane!.model?.effort && props.pane!.model && !efforts.value && !why.value) loadEfforts()
}, { immediate: true })
watch(() => props.pane?.id, () => { list.value = null; efforts.value = null; chosen.value = null })

const selectedModelIndex = computed(() => currentModelOption(list.value?.options || [], model.value))
const isCurrent = (o: ModelOption) => list.value?.options.indexOf(o) === selectedModelIndex.value
const displayModelOption = (o: ModelOption) => /^default \(recommended\)$/i.test(o.label) ? t('Default (recommended)') : o.label

async function choose(o: ModelOption) {
  if (isCurrent(o) || locked.value) return
  switching.value = true
  haptic()
  try {
    const r = await api<{ model: ModelInfo }>('/api/model', { pane_id: props.pane!.id, label: o.label })
    chosen.value = { info: r.model, at: Date.now() }
    efforts.value = null
    toast(tl(`Model: ${r.model.label} (this session)`, `Modèle : ${r.model.label} (cette session)`))
  } catch (err) {
    toast((err as Error).message, true)
  } finally {
    switching.value = false
  }
  if (!why.value) await loadEfforts()
}

async function chooseEffort(level: string) {
  if (locked.value || model.value?.effort === level) return
  switching.value = true
  haptic()
  try {
    const r = await api<{ model: ModelInfo }>('/api/effort', { pane_id: props.pane!.id, level })
    chosen.value = { info: r.model, at: Date.now() }
    if (efforts.value) efforts.value.current = level
    toast(tl(`Effort: ${level} (this session)`, `Effort : ${level} (cette session)`))
  } catch (err) { toast((err as Error).message, true) }
  finally { switching.value = false }
  // omp: each ⇧⇥ press shows more of the model's real levels.
  if (props.pane!.agent === 'omp' && !why.value) await loadEfforts()
}

const modelItems = computed(() => {
  const head = [{ type: 'label' as const, label: t('For this session only') }]
  if (modelsLoading.value || !list.value) {
    return [head, [{ label: t('Reading models…'), icon: 'i-lucide-loader-circle', disabled: true, class: 'model-loading' }]]
  }
  const opts = list.value.options.map(o => ({
    type: 'checkbox' as const,
    label: displayModelOption(o),
    description: o.hint || undefined,
    checked: isCurrent(o),
    onSelect: () => choose(o),
  }))
  const tail = [{
    label: t('Reload list'), icon: 'i-lucide-refresh-cw',
    onSelect: (e: Event) => { e.preventDefault(); loadModels(true) },
  }]
  return [head, opts, tail]
})
const effortItems = computed(() => {
  const head = [{ type: 'label' as const, label: t('For this session only') }]
  if (effortsLoading.value || !efforts.value) return [head, [{ label: t('Reading effort levels…'), icon: 'i-lucide-loader-circle', disabled: true }]]
  return [head, efforts.value.levels.map(level => ({
    type: 'checkbox' as const, label: level, checked: model.value?.effort === level,
    // omp "auto": the level it picked for this turn, else what it does.
    description: level !== 'auto' ? undefined
      : model.value?.effort === 'auto' && model.value.effortResolved ? tl(`This turn: ${model.value.effortResolved}`, `Ce tour : ${model.value.effortResolved}`)
        : props.pane!.agent === 'omp' ? t('Picks the level each turn') : undefined,
    onSelect: () => chooseEffort(level),
  }))]
})
// "auto · low": omp's auto level and what it resolved to this turn.
const effortText = computed(() => {
  const m = model.value
  if (!m?.effort) return null
  return m.effort === 'auto' && m.effortResolved ? `auto · ${m.effortResolved}` : m.effort
})
const showEffort = computed(() => ['claude', 'codex', 'omp'].includes(props.pane?.agent || '') &&
  Boolean(efforts.value?.levels.length || (model.value?.effort && !efforts.value)))

// Start: what the program takes on that machine, read when the program changes.
const startModels = ref<StartModels | null>(null)
const startFailed = ref(false)
let launchSeq = 0
async function loadStartModels(refresh = false) {
  const l = props.launch
  if (!l) return
  const id = ++launchSeq
  modelsLoading.value = true
  startFailed.value = false
  try {
    const r = await api<StartModels>(`/api/tasks/models?machine=${encodeURIComponent(l.machine)}&program=${encodeURIComponent(l.program)}${refresh ? '&refresh=1' : ''}`)
    if (id === launchSeq) { startModels.value = r; startFailed.value = !r.models.length }
  } catch {
    if (id === launchSeq) { startModels.value = null; startFailed.value = true }
  } finally { if (id === launchSeq) modelsLoading.value = false }
}
watch(() => props.launch && `${props.launch.machine}|${props.launch.program}`, (k) => {
  startModels.value = null
  launchModel.value = null
  launchEffort.value = null
  if (k) loadStartModels()
}, { immediate: true })
const launchLevels = computed(() => effortsFor(startModels.value, launchModel.value))
// A level the new model does not take is dropped, not kept for it.
watch(launchLevels, (lv) => { if (launchEffort.value && !lv.includes(launchEffort.value)) launchEffort.value = null })
const launchModelItems = computed(() => {
  const head = [{ type: 'label' as const, label: t('For this start only') }]
  if (modelsLoading.value || !startModels.value) return [head, [{ label: t('Reading models…'), icon: 'i-lucide-loader-circle', disabled: true, class: 'model-loading' }]]
  return [head, [
    { type: 'checkbox' as const, label: t('Program’s default'), checked: !launchModel.value, onSelect: () => { launchModel.value = null } },
    ...startModels.value.models.map(m => ({ type: 'checkbox' as const, label: m, checked: launchModel.value === m, onSelect: () => { launchModel.value = m } })),
  ], [{ label: t('Reload list'), icon: 'i-lucide-refresh-cw', onSelect: (e: Event) => { e.preventDefault(); loadStartModels(true) } }]]
})
const launchEffortItems = computed(() => [[{ type: 'label' as const, label: t('For this start only') }], [
  { type: 'checkbox' as const, label: t('Model’s default'), checked: !launchEffort.value, onSelect: () => { launchEffort.value = null } },
  ...launchLevels.value.map(level => ({ type: 'checkbox' as const, label: level, checked: launchEffort.value === level, onSelect: () => { launchEffort.value = level } })),
]])
const shownModelItems = computed(() => (props.launch ? launchModelItems.value : modelItems.value))
const shownEffortItems = computed(() => (props.launch ? launchEffortItems.value : effortItems.value))
const modelText = computed(() => (props.launch ? launchModel.value || t('Model') : model.value ? model.value.label : t('Model')))
const shownEffortText = computed(() => (props.launch ? launchEffort.value : effortText.value))
const effortShown = computed(() => (props.launch ? Boolean(launchLevels.value.length) : showEffort.value))
const modelShown = computed(() => !props.launch || !startFailed.value)
// Start has nothing to explain (never locked): no tooltip around its menus.
const UTooltip = resolveComponent('UTooltip')
const Tip = computed(() => (props.launch ? 'span' : UTooltip))
const modelTip = computed(() => (props.launch ? {} : { text: why.value || t('Change model'), disabled: !desk.value || (!why.value && modelOpen.value), content: { side: 'top' } }))
const effortTip = computed(() => (props.launch ? {} : { text: why.value || t('Change effort'), disabled: !desk.value || (!why.value && effortOpen.value), content: { side: 'top' } }))

// Selector unavailable: the menu does not open, we explain (on the phone,
// no tooltip). The button is not `disabled` so it receives the tap.
function setOpen(which: 'model' | 'effort', v: boolean) {
  if (v && locked.value) {
    if (why.value) toast(why.value, true)
    return
  }
  if (which === 'model') { modelOpen.value = v; if (v) effortOpen.value = false }
  else { effortOpen.value = v; if (v) modelOpen.value = false }
}
watch(locked, (l) => { if (l) { modelOpen.value = false; effortOpen.value = false } })
</script>

<template>
  <span v-if="!modelShown" class="model-pick-none" role="status">{{ t('Models could not be read: Start uses the program alone.') }}</span>
  <component :is="Tip" v-if="modelShown" v-bind="modelTip">
    <span class="model-pick-wrap">
      <UDropdownMenu
        :open="modelOpen" :items="shownModelItems" :modal="false"
        :content="{ side: 'top', align: 'start', sideOffset: 6 }"
        :ui="{ content: `hw-dropdown model-menu${launch ? ' z-[30]' : ''}`, itemDescription: 'model-hint', label: 'model-menu-label' }"
        @update:open="setOpen('model', $event)"
      >
        <UButton
          color="neutral" variant="ghost" size="xs" class="model-pick" :class="{ off: locked }"
          :aria-disabled="locked" :aria-label="`${t('Model')} : ${launch ? launchModel || t('Program’s default') : model ? model.label : t('Unknown model')}`"
          :trailing-icon="switching ? 'i-lucide-loader-circle' : 'i-lucide-chevron-down'"
          :ui="{ trailingIcon: switching ? 'animate-spin model-caret' : 'model-caret' }"
        >
          <span class="model-name">{{ modelText }}</span>
        </UButton>
      </UDropdownMenu>
    </span>
  </component>
  <component :is="Tip" v-if="effortShown" v-bind="effortTip">
    <span class="model-pick-wrap effort-pick-wrap">
      <UDropdownMenu
        :open="effortOpen" :items="shownEffortItems" :modal="false"
        :content="{ side: 'top', align: 'start', sideOffset: 6 }"
        :ui="{ content: `hw-dropdown model-menu effort-menu${launch ? ' z-[30]' : ''}`, itemDescription: 'model-hint', label: 'model-menu-label' }"
        @update:open="setOpen('effort', $event)"
      >
        <UButton
          color="neutral" variant="ghost" size="xs" class="model-pick effort-pick" :class="{ off: locked }"
          :aria-disabled="locked" :aria-label="`${t('Effort')} : ${shownEffortText || (launch ? t('Model’s default') : t('Unknown effort'))}`"
          :trailing-icon="switching ? 'i-lucide-loader-circle' : 'i-lucide-chevron-down'"
          :ui="{ trailingIcon: switching ? 'animate-spin model-caret' : 'model-caret' }"
        ><span class="model-name">{{ shownEffortText || t('Effort') }}</span></UButton>
      </UDropdownMenu>
    </span>
  </component>
</template>
