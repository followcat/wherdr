<script setup lang="ts">
// The project sheet's Machines block (General tab): the machines its tasks may
// run on. Home is the project's own (read only); each other one has its clone
// of the repo, and is added (among herdr-core's connected machines) or removed
// through project-update. Under each one: its last readiness check (ready: the
// sheet's reading of it), run again with Check and at once after an add
// (project-machine-check). Placement: how its
// tasks spread over these machines (shared/pm/placement.ts), saved at once.
// Each machine's switch: off, it is paused for the project (no new task goes
// there, tasks already there go on, its clone stays), saved at once.
// Live (read again every 10 s, /api/pm/project-machines): each machine's card
// (MachineLoad), the strategy in a small picture, and the next to-do task with
// where it would go, or why it waits. Until its card is read, each machine's
// memory reading as placement judges it (macOS: by its pressure).
import { allowedMachines, isPaused, type Project } from '#shared/pm/project'
import { STRATEGIES, STRATEGY_HINTS, STRATEGY_LABELS, type MachineNow, type Strategy } from '#shared/pm/placement'
import { memoryLabel } from '#shared/pm/memory'
import type { Weight } from '#shared/pm/weight'

const props = defineProps<{ project: Project, ready?: Record<string, string> }>()
const emit = defineEmits<{ changed: [] }>()
const p = computed(() => props.project)

const labelOf = (key: string) => machines.value.find(m => m.key === key)?.label ?? (key || tl('This machine'))
const others = computed(() => allowedMachines(p.value).slice(1))
onMounted(loadMemory)
const memOf = (k: string) => {
  const mem = memoryRows.value?.find(r => r.key === k)?.mem
  return mem ? memoryLabel(mem) : ''
}
const addable = computed(() => machines.value
  .filter(m => !m.session && (m.local || m.status === 'online') && !allowedMachines(p.value).includes(m.key))
  .map(m => ({ label: m.label, value: m.key })))

interface Next { task: string, title: string, weight: Weight, on?: string, hold?: string, why?: string }
const live = ref<{ machines: MachineNow[], next: Next | null } | null>(null)
const nowOf = (k: string) => live.value?.machines.find(m => m.key === k)
const loadLive = async () => {
  if (document.hidden) return
  try { live.value = await api(`/api/pm/project-machines?key=${encodeURIComponent(p.value.key)}`) }
  catch {} // the block works without it
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { loadLive(); timer = setInterval(loadLive, 10_000) })
onBeforeUnmount(() => clearInterval(timer))
watch(() => p.value, loadLive) // a machine added, removed, paused or another strategy
const nextText = (n: Next) => n.on
  ? tl(`Next: ${n.task} (${n.weight}) would go to ${n.on}`) + (n.why ? ` · ${tl(`waits: ${n.why}`)}` : '')
  : tl(`Next: ${n.task} (${n.weight}) waits: ${n.why ?? n.hold}`)
// The strategy's picture: home then two machines (the last the largest), the tasks as squares (big: heavy).
const PICTURE: Record<Strategy, number[][]> = { strongest: [[4, 4], [], [8]], balance: [[4], [4], [4]], home: [[4, 4, 4], [], []] }

const form = reactive({ machine: '', clone: '' })
const busy = ref('')
const error = ref('')
// Each machine's check run here: checking, or its failures ('' ready).
const checks = reactive<Record<string, { checking: true } | { refused: string }>>({})
// What shows under a machine: this sheet's check, else the last one wherdr ran, else none yet.
const status = (k: string) => {
  const c = checks[k]
  if (c && 'checking' in c) return { text: tl('Checking…'), bad: false }
  const refused = c ? c.refused : props.ready?.[k]
  if (refused === undefined) return { text: tl('Not checked yet'), bad: false }
  return refused ? { text: tl(`Not ready: ${refused}`), bad: true } : { text: tl('Ready'), bad: false }
}
async function check(k: string) {
  checks[k] = { checking: true }
  try { checks[k] = { refused: (await api<{ refused?: string }>('/api/pm/project-machine-check', { key: p.value.key, machine: k })).refused ?? '' } }
  catch (e) { checks[k] = { refused: (e as Error).message } }
}

const save = (machines: string[], clones: Record<string, string> = {}) => api('/api/pm/project-update', { key: p.value.key, machines, clones })
async function run(what: string, fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = what
  error.value = ''
  try { await fn() }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = '' }
}
const add = () => run('add', async () => {
  const k = form.machine
  await save([...others.value, k], { [k]: form.clone.trim() })
  Object.assign(form, { machine: '', clone: '' })
  emit('changed')
  await check(k)
})
const strategies = STRATEGIES.map(s => ({ label: tl(STRATEGY_LABELS[s]), value: s }))
const strategy = computed({
  get: () => p.value.placement ?? 'strongest',
  set: (placement: Strategy) => run('placement', async () => {
    await api('/api/pm/project-update', { key: p.value.key, placement })
    emit('changed')
  }),
})
const setOn = (k: string, on: boolean) => run(`pause:${k}`, async () => {
  const paused = (p.value.paused ?? []).filter(x => x !== k)
  await api('/api/pm/project-update', { key: p.value.key, paused: on ? paused : [...paused, k] })
  emit('changed')
})
const remove = (k: string) => run(`rm:${k}`, async () => {
  await save(others.value.filter(x => x !== k))
  delete checks[k]
  emit('changed')
})
</script>

<template>
  <div class="pm-machines" data-ui-target="project.machines" data-testid="pm-machines">
    <div class="pm-machine" data-testid="pm-machine-home">
      <span>{{ labelOf(p.machine) }} <small class="mono-label">{{ tl('Home') }}</small></span>
      <small class="pm-clone">{{ ltr(shortPath(p.path)) }}</small>
      <span v-if="others.length || isPaused(p, p.machine)" class="pm-machine-actions">
        <USwitch :model-value="!isPaused(p, p.machine)" color="success" size="lg" :disabled="busy !== ''" :aria-label="tl(`Take tasks on ${labelOf(p.machine)}`)" data-testid="pm-machine-on" @update:model-value="setOn(p.machine, $event)" />
        <i class="pm-slot" /><i class="pm-slot" />
      </span>
      <small v-if="memOf(p.machine) && !nowOf(p.machine)" class="pm-ready" data-testid="pm-machine-memory">{{ memOf(p.machine) }}</small>
      <small v-if="isPaused(p, p.machine)" class="pm-ready" data-testid="pm-machine-paused">{{ tl('Paused for this project: no new task starts here') }}</small>
      <MachineLoad v-if="nowOf(p.machine)" :m="nowOf(p.machine)!" />
    </div>
    <div v-for="k in others" :key="k" class="pm-machine" data-testid="pm-machine">
      <span>{{ labelOf(k) }}</span>
      <small class="pm-clone">{{ ltr(p.clones?.[k] ?? '') }}</small>
      <span class="pm-machine-actions">
        <USwitch :model-value="!isPaused(p, k)" color="success" size="lg" :disabled="busy !== ''" :aria-label="tl(`Take tasks on ${labelOf(k)}`)" data-testid="pm-machine-on" @update:model-value="setOn(k, $event)" />
        <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-refresh-cw" :aria-label="tl(`Check ${labelOf(k)}`)" :disabled="!!checks[k] && 'checking' in checks[k]!" data-testid="pm-machine-check" @click="check(k)" />
        <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-x" :aria-label="tl(`Remove ${labelOf(k)}`)" :loading="busy === `rm:${k}`" :disabled="busy !== ''" data-testid="pm-machine-remove" @click="remove(k)" />
      </span>
      <small v-if="memOf(k) && !nowOf(k)" class="pm-ready" data-testid="pm-machine-memory">{{ memOf(k) }}</small>
      <small v-if="isPaused(p, k)" class="pm-ready" data-testid="pm-machine-paused">{{ tl('Paused for this project: no new task starts here') }}</small>
      <small v-else class="pm-ready" :class="{ bad: status(k).bad }" data-testid="pm-machine-ready">{{ status(k).text }}</small>
      <MachineLoad v-if="nowOf(k)" :m="nowOf(k)!" />
    </div>
    <form class="pm-machine-add" @submit.prevent="add">
      <USelect v-model="form.machine" :items="addable" size="lg" :placeholder="tl('Add a machine')" :aria-label="tl('Machine to add')" data-testid="pm-machine-pick" />
      <UInput v-model="form.clone" size="lg" class="mono" placeholder="~/project" :aria-label="tl('Clone path on that machine')" maxlength="500" autocomplete="off" data-testid="pm-machine-clone" />
      <UButton type="submit" size="lg" color="neutral" variant="soft" :loading="busy === 'add'" :disabled="!form.machine || !form.clone.trim() || busy !== ''" data-testid="pm-machine-add">{{ tl('Add') }}</UButton>
    </form>
    <small class="muted">{{ tl('Tasks may start on these machines, each in its own clone of the repository.') }}</small>
    <label class="pm-placement">
      <span>{{ tl('Placement') }}</span>
      <USelect v-model="strategy" :items="strategies" size="lg" :disabled="busy !== ''" :aria-label="tl('Placement strategy')" data-testid="pm-placement" />
    </label>
    <span class="pm-strategy">
      <svg class="pm-picture" viewBox="0 0 54 22" aria-hidden="true">
        <g v-for="(tasks, i) in PICTURE[strategy]" :key="i">
          <rect :x="i * 18 + 0.5" :y="i === 2 ? 0.5 : 6.5" width="15" :height="i === 2 ? 21 : 15" fill="none" stroke="currentColor" />
          <rect v-for="(size, j) in tasks" :key="j" :x="i * 18 + 2 + (j % 2) * 6" :y="20 - size - Math.floor(j / 2) * 6" :width="size" :height="size" class="pm-picture-task" />
        </g>
      </svg>
      <small class="muted" data-testid="pm-strategy">{{ tl(STRATEGY_HINTS[strategy]) }}</small>
    </span>
    <p v-if="live" class="pm-next mono" :class="{ wait: !live.next?.on || live.next?.why }" data-testid="pm-next">
      {{ live.next ? nextText(live.next) : tl('Next: no task to do') }}
      <small v-if="live.next" class="muted">{{ live.next.title }}</small>
    </p>
    <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
  </div>
</template>

<style scoped>
.pm-machines { display: grid; gap: 8px; }
.pm-machine + .pm-machine { padding-top: 10px; border-top: 1px solid var(--line-soft); }
.pm-strategy { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pm-picture { flex: none; width: 54px; height: 22px; color: var(--line); }
.pm-picture-task { fill: var(--working); }
.pm-next { display: grid; gap: 2px; margin: 0; padding: 8px 10px; border: 1px solid var(--line); font-size: 13px; color: var(--green, var(--text)); overflow-wrap: anywhere; }
.pm-next.wait { color: var(--ochre); }
.pm-machine { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto; align-items: center; gap: 4px 10px; }
.pm-clone { color: var(--muted); font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12px; overflow-wrap: anywhere; }
.pm-machine-actions { display: flex; align-items: center; gap: 2px; }
.pm-slot { width: 28px; } /* home has no check or remove: its switch lines up with the others' */
.pm-ready { grid-column: 1 / -1; color: var(--muted); overflow-wrap: anywhere; }
.pm-ready.bad { color: var(--blocked); }
.pm-placement { display: flex; align-items: center; gap: 10px; }
.pm-machine-add { display: grid; grid-template-columns: minmax(0, 160px) minmax(0, 1fr) auto; gap: 8px; }
@media (max-width: 520px) { .pm-machine-add { grid-template-columns: minmax(0, 1fr) auto; } .pm-machine-add > :nth-child(2) { grid-column: 1 / -1; grid-row: 2; } }
</style>
