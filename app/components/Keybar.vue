<script setup lang="ts">
// Key bar: logical keys, encoded by Herdr according to the terminal
// mode (application cursor, etc.). Does not steal the focus from the input field.
import { VIRTUAL_MODIFIERS, type VirtualModifier } from '~/utils/terminalModifiers'
import { createKeyboardTap } from '~/utils/keyboardTap'
const props = defineProps<{ ctl: TerminalCtl, allDigits?: boolean, compact?: boolean, terminal?: boolean }>()
const emit = defineEmits<{ keyboard: [] }>()
const modifierLabels = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }
const selected = computed(() => props.ctl.virtualModifiers.value)
function modifier(key: VirtualModifier) { haptic(); props.ctl.toggleModifier(key) }

// Most used first (esc, arrows, tab, ^C, y, n): on a narrow column the rest
// scrolls, the keyboard toggle stays pinned at the end.
const KEYS: { key: string, label: string, cls?: string }[] = [
  { key: 'esc', label: 'esc' }, { key: 'up', label: '↑' }, { key: 'down', label: '↓' }, { key: 'left', label: '←' }, { key: 'right', label: '→' },
  { key: 'tab', label: 'tab' }, { key: 'ctrl+c', label: '^C', cls: 'danger' }, { key: 'y', label: 'y' }, { key: 'n', label: 'n' },
  { key: 'enter', label: '⏎', cls: 'wide' }, { key: 'shift+tab', label: '⇧tab' }, { key: 'backspace', label: '⌫' },
  { key: '1', label: '1' }, { key: '2', label: '2' }, { key: '3', label: '3' },
]
const keys = computed<{ key: string, label: string, cls?: string }[]>(() => props.allDigits
  ? [...KEYS, ...['4', '5', '6', '7', '8', '9', '0'].map(key => ({ key, label: key }))]
  : KEYS)

function press(key: string) {
  haptic()
  void props.ctl.sendVirtualKey(key)
}
function toggleKbd() {
  if (props.ctl.hasFocus()) props.ctl.blur()
  else props.ctl.focus()
}
const keyboardTap = createKeyboardTap(toggleKbd)
</script>

<template>
  <PhoneKeybar v-if="compact" :ctl="ctl" :all-digits="allDigits" :terminal="terminal" @keyboard="emit('keyboard')" />
  <div v-else class="keybar" role="toolbar" :aria-label="t('Keys')">
    <div class="keybar-keys">
      <button v-for="k in keys" :key="k.key" type="button" :class="k.cls" @pointerdown.prevent @click="press(k.key)">{{ k.label }}</button>
      <button v-for="m in VIRTUAL_MODIFIERS" :key="m" type="button" class="key-modifier" :aria-label="t(modifierLabels[m])"
        :aria-pressed="selected.includes(m)" @pointerdown.prevent @click="modifier(m)">{{ t(modifierLabels[m]) }}</button>
    </div>
    <button type="button" class="kbd" :class="{ on: ctl.kbdOn.value }" :aria-label="t('Type in terminal')" @pointerdown.prevent @click="keyboardTap.click"
      @touchstart.passive="keyboardTap.start" @touchmove.passive="keyboardTap.move" @touchend="keyboardTap.end" @touchcancel="keyboardTap.cancel">
      <UIcon name="i-lucide-keyboard" />
    </button>
  </div>
</template>

<style scoped>
.key-modifier[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
</style>
