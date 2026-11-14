<script setup lang="ts">
import { createKeyboardTap } from '~/utils/keyboardTap'
import type { VirtualModifier } from '~/utils/terminalModifiers'
import { displayVirtualChord } from '~/utils/keybarKeys'
import { PHONE_KEYS, type PhoneKey } from '~/utils/phoneKeys'
import { shownKeys } from '~/utils/keybarOrder'

const props = defineProps<{ ctl: TerminalCtl, allDigits?: boolean, terminal?: boolean }>()
const emit = defineEmits<{ keyboard: [] }>()
// The order and shown keys chosen in Settings › Terminal (utils/keybarOrder.ts); the digits stay last.
const keys = computed(() => shownKeys(phoneKeyOrder.value, phoneKeyHidden.value).map(id => PHONE_KEYS[id]))
const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
const active = computed(() => props.ctl.virtualModifiers.value)
const preview = computed(() => active.value.length
  ? `${displayVirtualChord(active.value.join('+'))} + …`
  : props.ctl.lastVirtualChord.value || t('One-shot chord'))
function modifier(key: VirtualModifier) { haptic(); props.ctl.toggleVirtualModifier(key) }
function press(key: string) { haptic(); void props.ctl.sendVirtualKey(key) }
function toggleKbd() {
  if (!props.terminal) { emit('keyboard'); return }
  if (props.ctl.hasFocus()) props.ctl.blur()
  else props.ctl.focus()
}
const keyboardTap = createKeyboardTap(toggleKbd)
// The keyboard key acts on touchend (iOS opens the keyboard only from a user gesture); see utils/keyboardTap.ts.
const isKbd = (k: PhoneKey) => k.kind === 'keyboard'
function activate(k: PhoneKey) {
  if (isKbd(k)) keyboardTap.click()
  else if (k.kind === 'modifier') modifier(k.modifier!)
  else press(k.send!)
}
const isOn = (k: PhoneKey) => isKbd(k) ? Boolean(props.terminal && props.ctl.kbdOn.value) : k.kind === 'modifier' && active.value.includes(k.modifier!)
</script>

<template>
  <div class="keybar virtual-keyboard" role="group" :aria-label="t('Terminal function keys')">
    <output class="vk-announcement" aria-live="polite">{{ preview }}</output>
    <div class="vk-strip" role="toolbar" :aria-label="t('Common keys and modifiers')">
      <button
        v-for="k in keys" :key="k.id" type="button" :data-key="k.id"
        :class="{ 'vk-mod': k.kind === 'modifier', danger: k.danger, selected: isOn(k) }"
        :aria-pressed="k.kind === 'modifier' ? isOn(k) : undefined" :aria-label="k.label()"
        @pointerdown.prevent @click="activate(k)"
        @touchstart.passive="isKbd(k) && keyboardTap.start($event)" @touchmove.passive="isKbd(k) && keyboardTap.move($event)"
        @touchend="isKbd(k) && keyboardTap.end($event)" @touchcancel="isKbd(k) && keyboardTap.cancel()"
      >
        <UIcon v-if="k.icon && k.kind === 'keyboard'" :name="k.icon" mode="svg" />
        <UIcon v-else-if="k.icon" :name="k.icon" mode="svg" class="vk-key-icon" aria-hidden="true" />
        <template v-else>{{ k.cap!() }}</template>
      </button>
      <template v-if="allDigits"><button v-for="d in digits" :key="d" type="button" :aria-label="d" @pointerdown.prevent @click="press(d)">{{ d }}</button></template>
    </div>
  </div>
</template>

<style scoped>
.keybar.virtual-keyboard { display: block; flex: none; padding: 0; border: 0; background: transparent; background-image: none; overflow: visible; }
.keybar.virtual-keyboard::before { content: none; }
.vk-strip { display: flex; gap: 6px; padding: 5px 11px; overflow-x: auto; scrollbar-width: none; overscroll-behavior-x: contain; }
.vk-strip::-webkit-scrollbar { display: none; }
.virtual-keyboard button { position: relative; display: grid; place-items: center; flex: none; min-width: 38px; height: 36px; margin: 0; padding: 0 3px; border: 1px solid var(--line-soft); border-radius: 0; background: var(--bg-2); color: var(--text-2); font: 500 12px/1 var(--mono); user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: manipulation; }
.virtual-keyboard button::after { content: ''; position: absolute; top: -5px; bottom: -5px; left: -4px; right: -4px; }
.virtual-keyboard button.selected { border-color: var(--accent); color: var(--accent); }
.virtual-keyboard button:active { background: var(--surface-3); }
.virtual-keyboard button.danger { color: var(--rose); border-color: var(--rose); }
.virtual-keyboard .vk-key-icon { width: 19px; height: 19px; flex: none; }
.vk-announcement { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; } /* overflow-safe: visually hidden: absolute, 1px, clipped */
</style>
