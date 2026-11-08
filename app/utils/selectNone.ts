// USelect (Reka UI) refuses '' as an item value: '' clears it to its placeholder.
// A "none" or "all" choice ('' in the app's data) uses NONE inside the select only.
import { computed, type Ref } from 'vue'

export const NONE = '__none__'
export const orNone = (v?: string | null) => v || NONE
export const fromNone = (v: unknown) => (v === NONE || v == null ? '' : String(v))
// v-model for a USelect bound to a string where '' means none.
export const noneModel = (r: Ref<string>) => computed({ get: () => orNone(r.value), set: (v: string) => { r.value = fromNone(v) } })
