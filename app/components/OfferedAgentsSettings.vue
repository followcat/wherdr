<script setup lang="ts">
// Settings › Agents › Offered agents: the one list every agent picker uses
// (New sheet, coordinators, Alfred). Uncheck a program to hide it everywhere;
// drag a row by its ⠿ handle (or arrow keys on it), or use its up and down
// buttons: the first is the default everywhere. Follows the user on every device.
import { moveAgent } from '~/utils/agentChoices'

const list = ref<HTMLElement | null>(null)
const announcement = ref('')
const rows = installedAgents

function move(kind: string, to: number) {
  const from = rows.value.indexOf(kind)
  if (from === to) return
  agentOrder.value = moveAgent(rows.value, agentOrder.value, from, to)
  haptic()
  announcement.value = tl(`${kindLabel(kind)}: position ${to + 1} of ${rows.value.length}`, `${kindLabel(kind)} : position ${to + 1} sur ${rows.value.length}`)
}
const { drag, shift, onGrab } = useRowDrag(list, move)
function focusIn(kind: string, selector: string) {
  nextTick(() => {
    const row = list.value?.querySelector<HTMLElement>(`[data-row="${CSS.escape(kind)}"]`)
    const el = row?.querySelector<HTMLButtonElement>(selector)
    if (el && !el.disabled) el.focus()
    else row?.querySelector<HTMLElement>('.key-order-step:not(:disabled)')?.focus()
  })
}
function step(kind: string, delta: -1 | 1) {
  move(kind, rows.value.indexOf(kind) + delta)
  focusIn(kind, delta < 0 ? '.key-order-up' : '.key-order-down')
}
function onKey(kind: string, e: KeyboardEvent) {
  const at = rows.value.indexOf(kind)
  if (e.key === 'ArrowUp' && at > 0) move(kind, at - 1)
  else if (e.key === 'ArrowDown' && at < rows.value.length - 1) move(kind, at + 1)
  else return
  e.preventDefault()
  focusIn(kind, '.bar-pref-grip')
}

const checked = (kind: string) => !hiddenAgents.value.includes(kind)
function setChecked(kind: string, on: boolean) {
  hiddenAgents.value = on ? hiddenAgents.value.filter(k => k !== kind) : [...hiddenAgents.value, kind]
}
// The default: the first one still checked.
const first = computed(() => rows.value.find(checked))
function machineHint(kind: string) {
  const available = agentMachines.value.filter(m => m.kinds.includes(kind))
  if (available.length === agentMachines.value.length) return ''
  return available.map(m => m.label || t('This machine')).join(', ')
}
</script>

<template>
  <div class="settings-group" data-testid="offered-agents">
    <h3>{{ t('Offered agents') }}</h3>
    <p class="muted agent-pref-intro">{{ tl('Agents offered wherever an agent is chosen, in this order: the first is the default. Terminal is always available.', 'Agents proposés partout où l’on choisit un agent, dans cet ordre : le premier est le choix par défaut. Le Terminal est toujours disponible.') }}</p>
    <ul v-if="rows.length" ref="list" class="bar-pref-list agent-pref-list" :class="{ dragging: drag }" :aria-label="t('Offered agents')">
      <li
        v-for="(kind, i) in rows" :key="kind" class="bar-pref-row" :class="{ moving: drag?.id === kind, off: !checked(kind) }"
        :style="{ transform: shift(i) }" :data-row="kind"
      >
        <button
          type="button" class="bar-pref-grip" :aria-label="tl(`Move ${kindLabel(kind)} — up and down arrows`, `Déplacer ${kindLabel(kind)} — flèches haut et bas`)"
          :title="t('Drag to reorder')" @pointerdown="onGrab(kind, $event)" @keydown="onKey(kind, $event)"
        >⠿</button>
        <label class="agent-pref-label">
          <input class="agent-pref-check" type="checkbox" :checked="checked(kind)" @change="setChecked(kind, ($event.target as HTMLInputElement).checked)">
          <span class="agent-pref-name"><b>{{ kindLabel(kind) }}</b><small v-if="machineHint(kind)">{{ machineHint(kind) }}</small></span>
          <small v-if="kind === first" class="agent-pref-default">{{ tl('Default', 'Par défaut') }}</small>
        </label>
        <button
          type="button" class="key-order-step key-order-up" :disabled="i === 0"
          :aria-label="tl(`Move ${kindLabel(kind)} up`, `Monter ${kindLabel(kind)}`)" @click="step(kind, -1)"
        ><UIcon name="i-lucide-chevron-up" /></button>
        <button
          type="button" class="key-order-step key-order-down" :disabled="i === rows.length - 1"
          :aria-label="tl(`Move ${kindLabel(kind)} down`, `Descendre ${kindLabel(kind)}`)" @click="step(kind, 1)"
        ><UIcon name="i-lucide-chevron-down" /></button>
      </li>
    </ul>
    <p v-else class="muted agent-pref-intro">{{ t('No agents installed on online machines.') }}</p>
    <p class="key-order-announcement" aria-live="polite">{{ announcement }}</p>
    <p class="muted agent-pref-note">{{ tl('Choices and order follow you on every device.', 'Choix et ordre te suivent sur tous tes appareils.') }}</p>
  </div>
</template>

<style scoped>
.agent-pref-label { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 8px 10px 8px 12px; cursor: pointer; }
.agent-pref-name { display: grid; flex: 1; min-width: 0; }
.agent-pref-name b { font-size: 15px; font-weight: 600; color: var(--text); }
.bar-pref-row.off .agent-pref-name b { color: var(--dim); }
.agent-pref-name small { overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.agent-pref-default { flex: none; font: 500 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--green); }
</style>
