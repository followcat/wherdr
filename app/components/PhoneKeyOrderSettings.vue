<script setup lang="ts">
// Settings › Terminal › Phone key bar: the order of the keys in the phone key
// bar (PhoneKeybar.vue), the same in the Conversation and the Terminal. Drag
// a row by its ⠿ handle (or arrow keys on it), or use its up and down buttons.
// Kept on this device (composables/useHerdr.ts, utils/keybarOrder.ts).
import { isDefaultKeyOrder, moveKey, PHONE_KEY_IDS, type PhoneKeyId } from '~/utils/keybarOrder'
import { PHONE_KEYS, phoneKeyName } from '~/utils/phoneKeys'

const rows = computed(() => phoneKeyOrder.value.map(id => PHONE_KEYS[id]))
const isDefault = computed(() => isDefaultKeyOrder(phoneKeyOrder.value))
const announcement = ref('')
const list = ref<HTMLElement | null>(null)

function move(id: PhoneKeyId, to: number) {
  const next = moveKey(phoneKeyOrder.value, id, to)
  if (next.join('\n') === phoneKeyOrder.value.join('\n')) return
  phoneKeyOrder.value = next
  haptic()
  const at = next.indexOf(id) + 1
  announcement.value = tl(`${phoneKeyName(PHONE_KEYS[id])}: position ${at} of ${next.length}`, `${phoneKeyName(PHONE_KEYS[id])} : position ${at} sur ${next.length}`)
}
function focusIn(id: PhoneKeyId, selector: string) {
  nextTick(() => {
    const row = list.value?.querySelector<HTMLElement>(`[data-key-row="${CSS.escape(id)}"]`)
    const el = row?.querySelector<HTMLButtonElement>(selector)
    if (el && !el.disabled) el.focus()
    else row?.querySelector<HTMLElement>('.key-order-step:not(:disabled)')?.focus()
  })
}
function step(id: PhoneKeyId, delta: -1 | 1) {
  move(id, phoneKeyOrder.value.indexOf(id) + delta)
  focusIn(id, delta < 0 ? '.key-order-up' : '.key-order-down')
}
function onKey(id: PhoneKeyId, e: KeyboardEvent) {
  const at = phoneKeyOrder.value.indexOf(id)
  if (e.key === 'ArrowUp' && at > 0) move(id, at - 1)
  else if (e.key === 'ArrowDown' && at < phoneKeyOrder.value.length - 1) move(id, at + 1)
  else return
  e.preventDefault()
  focusIn(id, '.bar-pref-grip')
}
function reset() {
  phoneKeyOrder.value = [...PHONE_KEY_IDS]
  announcement.value = tl('Default order restored', 'Ordre par défaut rétabli')
}

// Drag by the handle (mouse, finger, pen), as in MachineBarSettings.vue: the
// row follows the pointer, the others make room, the order is saved on release.
const drag = ref<{ id: PhoneKeyId, from: number, dy: number, to: number, h: number } | null>(null)
function shift(i: number) {
  const d = drag.value
  if (!d) return undefined
  if (i === d.from) return `translateY(${d.dy}px)`
  if (d.from < i && i <= d.to) return `translateY(${-d.h}px)`
  if (d.to <= i && i < d.from) return `translateY(${d.h}px)`
  return undefined
}
function blockScroll(e: TouchEvent) { if (drag.value) e.preventDefault() }
let release: (() => void) | null = null
onBeforeUnmount(() => release?.())
function onGrab(id: PhoneKeyId, e: PointerEvent) {
  if (drag.value || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
  e.preventDefault()
  const els = [...(list.value?.querySelectorAll<HTMLElement>('[data-key-row]') || [])]
  const from = els.findIndex(el => el.dataset.keyRow === id)
  if (from < 0) return
  const mids = els.map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 })
  const h = els[from]!.getBoundingClientRect().height
  const y0 = e.clientY
  drag.value = { id, from, dy: 0, to: from, h }
  haptic()
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId || !drag.value) return
    const dy = ev.clientY - y0
    const y = mids[from]! + dy
    const to = mids.filter((m, i) => i !== from && m < y).length
    if (to !== drag.value.to) haptic()
    drag.value = { ...drag.value, dy, to }
  }
  const end = (save: boolean) => (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return
    const d = drag.value
    release?.()
    if (save && d && d.to !== d.from) move(id, d.to)
  }
  const up = end(true)
  const cancel = end(false)
  release = () => {
    release = null
    drag.value = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    document.removeEventListener('touchmove', blockScroll)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  // iOS: the page stays still while the row moves.
  document.addEventListener('touchmove', blockScroll, { passive: false })
}
</script>

<template>
  <div class="settings-group phone-key-order">
    <h3>{{ tl('Phone key bar', 'Barre de touches du téléphone') }}</h3>
    <p class="muted settings-lead">{{ tl('One row that scrolls sideways, in the Conversation and the Terminal: only the first keys show at once. Put the ones you use most first.', 'Une seule rangée qui défile sur le côté, dans la Conversation et le Terminal : seules les premières touches sont visibles d’emblée. Mets en tête celles dont tu te sers le plus.') }}</p>
    <p class="bar-pref-head">{{ tl('Preview', 'Aperçu') }}</p>
    <div class="key-order-preview" aria-hidden="true">
      <span v-for="k in rows" :key="k.id" class="key-order-cap" :class="{ danger: k.danger }" :data-key="k.id">
        <UIcon v-if="k.icon" :name="k.icon" mode="svg" /><template v-else>{{ k.cap!() }}</template>
      </span>
    </div>
    <p class="bar-pref-head">{{ tl('Order', 'Ordre') }}</p>
    <ul ref="list" class="bar-pref-list key-order-list" :class="{ dragging: drag }" :aria-label="tl('Order of the phone keys', 'Ordre des touches du téléphone')">
      <li
        v-for="(k, i) in rows" :key="k.id" class="bar-pref-row" :class="{ moving: drag?.id === k.id }"
        :style="{ transform: shift(i) }" :data-key-row="k.id"
      >
        <button
          type="button" class="bar-pref-grip" :aria-label="tl(`Move ${phoneKeyName(k)} — up and down arrows`, `Déplacer ${phoneKeyName(k)} — flèches haut et bas`)"
          :title="t('Drag to reorder')" @pointerdown="onGrab(k.id, $event)" @keydown="onKey(k.id, $event)"
        >⠿</button>
        <span class="key-order-label">
          <span class="key-order-cap" :class="{ danger: k.danger }" aria-hidden="true"><UIcon v-if="k.icon" :name="k.icon" mode="svg" /><template v-else>{{ k.cap!() }}</template></span>
          <span class="key-order-name">{{ phoneKeyName(k) }}</span>
        </span>
        <button
          type="button" class="key-order-step key-order-up" :disabled="i === 0"
          :aria-label="tl(`Move ${phoneKeyName(k)} up`, `Monter ${phoneKeyName(k)}`)" @click="step(k.id, -1)"
        ><UIcon name="i-lucide-chevron-up" /></button>
        <button
          type="button" class="key-order-step key-order-down" :disabled="i === rows.length - 1"
          :aria-label="tl(`Move ${phoneKeyName(k)} down`, `Descendre ${phoneKeyName(k)}`)" @click="step(k.id, 1)"
        ><UIcon name="i-lucide-chevron-down" /></button>
      </li>
    </ul>
    <p class="key-order-announcement" aria-live="polite">{{ announcement }}</p>
    <UButton color="neutral" variant="outline" icon="i-lucide-rotate-ccw" class="bar-pref-reset" :disabled="isDefault" @click="reset">
      {{ tl('Reset to default order', 'Rétablir l’ordre par défaut') }}
    </UButton>
    <p class="muted settings-hint">{{ tl('Saved on this device.', 'Enregistré sur cet appareil.') }}</p>
  </div>
</template>
