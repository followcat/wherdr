<script setup lang="ts">
// Key bar: logical keys, encoded by Herdr according to the terminal
// mode (application cursor, etc.). Does not steal the focus from the input field.
import type { VirtualModifier } from '~/utils/virtualKeys'
import { displayVirtualChord, virtualChord } from '~/utils/virtualKeys'
const VIRTUAL_MODIFIERS = ['ctrl', 'alt', 'shift'] as const
// `sendWith`: chords that end the conversation draft ("Send with Tab"),
// annotated on their key instead of reaching the terminal.
const props = defineProps<{ ctl: TerminalCtl, allDigits?: boolean, compact?: boolean, sendWith?: string[] }>()
const modifierLabels = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }
const selected = computed(() => props.ctl.virtualModifiers.value)
const withKey = (key: string) => props.sendWith?.includes(virtualChord(key, selected.value)) || false
function modifier(key: VirtualModifier) { haptic(); props.ctl.toggleModifier(key) }

const KEYS: { key: string, label: string, cls?: string }[] = [
  { key: 'esc', label: 'esc' }, { key: 'enter', label: '⏎', cls: 'wide' }, { key: 'up', label: '↑' }, { key: 'down', label: '↓' },
  { key: '1', label: '1' }, { key: '2', label: '2' }, { key: '3', label: '3' }, { key: 'tab', label: 'tab' },
  { key: 'shift+tab', label: '⇧tab' }, { key: 'left', label: '←' }, { key: 'right', label: '→' },
  { key: 'ctrl+c', label: '^C', cls: 'danger' }, { key: 'backspace', label: '⌫' }, { key: 'y', label: 'y' }, { key: 'n', label: 'n' },
]
const keys = computed<{ key: string, label: string, cls?: string }[]>(() => props.allDigits
  ? [...KEYS.slice(0, 7), ...['4', '5', '6', '7', '8', '9', '0'].map(key => ({ key, label: key })), ...KEYS.slice(7)]
  : KEYS)

function press(key: string) {
  haptic()
  void props.ctl.sendVirtualKey(key)
}
function toggleKbd() {
  if (props.ctl.hasFocus()) props.ctl.blur()
  else props.ctl.focus()
}
</script>

<template>
  <PhoneKeybar v-if="compact" :ctl="ctl" :all-digits="allDigits" :send-with="sendWith" />
  <div v-else class="keybar" role="toolbar" :aria-label="t('Keys')">
    <button v-for="m in VIRTUAL_MODIFIERS" :key="m" type="button" class="key-modifier" :aria-label="t(modifierLabels[m])"
      :aria-pressed="selected.includes(m)" @pointerdown.prevent @click="modifier(m)">{{ t(modifierLabels[m]) }}</button>
    <button v-for="k in keys" :key="k.key" type="button" :class="[k.cls, { 'send-with': withKey(k.key) }]" :title="withKey(k.key) ? tl(`Send with ${displayVirtualChord(virtualChord(k.key, selected))}`, `Envoyer avec ${displayVirtualChord(virtualChord(k.key, selected))}`) : undefined" @pointerdown.prevent @click="press(k.key)">{{ k.label }}</button>
    <button type="button" class="kbd" :class="{ on: ctl.kbdOn.value }" :aria-label="t('Type in terminal')" @pointerdown.prevent @click="toggleKbd">
      <UIcon name="i-lucide-keyboard" />
    </button>
  </div>
</template>

<style scoped>
.key-modifier[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.keybar button.send-with { border-color: var(--accent); color: var(--accent); font-weight: 650; }
</style>
