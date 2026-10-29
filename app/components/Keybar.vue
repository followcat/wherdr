<script setup lang="ts">
import type { VirtualModifier } from '~/utils/virtualKeys'
import { displayVirtualChord } from '~/utils/virtualKeys'

const props = defineProps<{ ctl: TerminalCtl, allDigits?: boolean }>()
const expanded = ref(false)
const modifiers: { key: VirtualModifier, label: string }[] = [
  { key: 'shift', label: 'Shift' },
]
const extraModifiers: { key: VirtualModifier, label: string }[] = [
  { key: 'ctrl', label: 'Ctrl' }, { key: 'alt', label: 'Alt' },
]
const nav = [
  { key: 'tab', label: '⇥' },
  { key: 'left', label: '←' }, { key: 'up', label: '↑' }, { key: 'down', label: '↓' },
  { key: 'right', label: '→' }, { key: 'enter', label: '⏎' },
]
const functionKeys = [
  { key: 'tab', label: 'Tab' },
  { key: 'pageup', label: 'PgUp' }, { key: 'pagedown', label: 'PgDn' },
  { key: 'home', label: 'Home' }, { key: 'end', label: 'End' },
  { key: 'delete', label: 'Del' }, { key: 'insert', label: 'Ins' },
  ...Array.from({ length: 12 }, (_, i) => ({ key: `f${i + 1}`, label: `F${i + 1}` })),
]
const active = computed(() => props.ctl.virtualModifiers.value)
const preview = computed(() => active.value.length
  ? `${displayVirtualChord(active.value.join('+'))} + …`
  : props.ctl.lastVirtualChord.value || '单次组合')

function modifier(key: VirtualModifier) { haptic(); props.ctl.toggleVirtualModifier(key) }
function press(key: string) { haptic(); void props.ctl.sendVirtualKey(key) }
function toggleMore() {
  haptic()
  expanded.value = !expanded.value
}
function toggleKbd() {
  expanded.value = false
  if (props.ctl.hasFocus()) props.ctl.blur()
  else props.ctl.focus()
}
</script>

<template>
  <div class="keybar virtual-keyboard" role="group" aria-label="终端功能键">
    <output class="vk-announcement" aria-live="polite">{{ preview }}</output>
    <div class="vk-strip" role="toolbar" aria-label="常用按键与修饰键">
      <button type="button" class="vk-escape" aria-label="Esc" @pointerdown.prevent @click="press('esc')">Esc</button>
      <button v-for="m in modifiers" :key="m.key" type="button" class="vk-mod" :class="{ selected: active.includes(m.key) }"
        :aria-pressed="active.includes(m.key)" :aria-label="t(m.label)" @pointerdown.prevent @click="modifier(m.key)">{{ m.key === 'shift' ? '⇧' : t(m.label) }}</button>
      <button v-for="k in nav" :key="k.key" type="button" class="vk-navigation" :aria-label="displayVirtualChord(k.key)" @pointerdown.prevent @click="press(k.key)">{{ k.label }}</button>
      <button type="button" class="vk-more" :class="{ selected: expanded }" :aria-expanded="expanded" aria-label="展开或收起功能键" @pointerdown.prevent @click="toggleMore"><UIcon :name="expanded ? 'i-lucide-chevron-down' : 'i-lucide-ellipsis'" /></button>
    </div>
    <div v-if="expanded" class="vk-extra-row" role="toolbar" aria-label="更多功能键">
      <button type="button" class="vk-system" :class="{ selected: ctl.kbdOn.value }" aria-label="打开或关闭手机键盘" @pointerdown.prevent @click="toggleKbd"><UIcon name="i-lucide-keyboard" /></button>
      <div class="vk-function-scroll" aria-label="左右滑动选择功能键">
        <button v-for="m in extraModifiers" :key="m.key" type="button" class="vk-mod" :class="{ selected: active.includes(m.key) }"
          :aria-pressed="active.includes(m.key)" :aria-label="t(m.label)" @pointerdown.prevent @click="modifier(m.key)">{{ t(m.label) }}</button>
        <button v-for="k in functionKeys" :key="k.key" type="button" :aria-label="displayVirtualChord(k.key)" @pointerdown.prevent @click="press(k.key)">{{ k.label }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.keybar.virtual-keyboard { display: block; flex: none; overflow: hidden; padding: 4px 8px; border-top: 1px solid var(--line-soft); background: var(--bg); background-image: none; }
.keybar.virtual-keyboard::before { content: none; }
.virtual-keyboard button { min-width: 0; height: 44px; margin: 0; padding: 0 3px; border: 1px solid var(--line-soft); border-radius: 4px; background: var(--bg-2); color: var(--text-2); font: 500 12px/1 var(--mono); user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: manipulation; }
.virtual-keyboard button.selected { background: var(--mauve); border-color: var(--mauve); color: var(--bg); }
.virtual-keyboard button:active { filter: brightness(1.25); }
.virtual-keyboard button:disabled { opacity: .35; }
.vk-strip { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 3px; }
.vk-strip .vk-escape { color: var(--text); border-color: var(--line); font-weight: 650; }
.vk-strip .vk-mod, .vk-strip .vk-navigation { font-size: 19px; }
.vk-announcement { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.vk-extra-row { display: flex; gap: 4px; margin-top: 4px; }
.vk-extra-row > button { flex: 0 0 40px; }
.vk-function-scroll { display: flex; flex: 1; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; overscroll-behavior-x: contain; touch-action: pan-x; }
.vk-function-scroll::-webkit-scrollbar { display: none; }
.vk-function-scroll button { flex: none; min-width: 44px; padding: 0 7px; font-size: 11px; }
</style>
