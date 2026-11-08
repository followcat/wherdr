// Nuxt UI's USelect renders a button and a menu in a portal, not a <select>:
// component tests find it by data-testid and pick a value the way the menu does.
import { nextTick } from 'vue'

interface Wrapper { findAllComponents: (s: { name: string }) => { vm: { $attrs: Record<string, unknown>, $emit: (e: string, v: unknown) => void }, props: (k: string) => unknown }[] }
export const selects = (w: Wrapper, id: string) => w.findAllComponents({ name: 'USelect' }).filter(c => c.vm.$attrs['data-testid'] === id)
export const select = (w: Wrapper, id: string, i = 0) => selects(w, id)[i]!
export const selectValue = (w: Wrapper, id: string, i = 0) => select(w, id, i).props('modelValue')
export const selectLabels = (w: Wrapper, id: string, i = 0) => (select(w, id, i).props('items') as unknown[]).flat().map(x => (x as { label: string }).label)
export async function pick(w: Wrapper, id: string, value: string, i = 0) {
  select(w, id, i).vm.$emit('update:modelValue', value)
  await nextTick()
}
