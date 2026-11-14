<script setup lang="ts">
// The archived tasks of the board's projects (the Done column's footer opens
// it): newest archived first, a search on title, id or tag, a page at a time.
// A tap opens the task's sheet (`pick`).
import type { Card } from '#shared/pm/board'

const props = defineProps<{ projects: string[] }>()
const emit = defineEmits<{ pick: [card: Card], closed: [] }>()
const open = ref(true)
const q = ref('')
const cards = ref<Card[]>([])
const total = ref(0)
const busy = ref(false)
const error = ref('')

let asked = 0
async function load(more = false) {
  const n = ++asked
  busy.value = true
  try {
    const params = new URLSearchParams({ projects: props.projects.join(','), q: q.value, offset: String(more ? cards.value.length : 0) })
    const r = await api<{ cards: Card[], total: number }>(`/api/pm/archived?${params}`)
    if (n !== asked) return // a newer search answered first
    cards.value = more ? [...cards.value, ...r.cards] : r.cards
    total.value = r.total
    error.value = ''
  }
  catch (e) { error.value = (e as Error).message }
  finally { if (n === asked) busy.value = false }
}
onMounted(() => load())
watch(taskSheetTick, () => load()) // a task unarchived from its sheet leaves the list
let typing: ReturnType<typeof setTimeout> | undefined
watch(q, () => { clearTimeout(typing); typing = setTimeout(() => load(), 250) })
onBeforeUnmount(() => clearTimeout(typing))
const row = (c: Card) => ({ shown: c.shown, color: c.color, title: c.title, label: 'Archived', action: c.archived ? fmtWhen(new Date(c.archived).toISOString()) : '' })
</script>

<template>
  <AppSheet v-model:open="open" :title="tl('Archived tasks')" tall @closed="emit('closed')">
    <div class="archived" data-testid="archived-sheet">
      <UInput v-model="q" icon="i-lucide-search" size="xl" class="w-full" :placeholder="tl('Search title, id or tag')" :aria-label="tl('Search archived tasks')" autocomplete="off" data-testid="archived-search" />
      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="!busy && !cards.length" class="muted">{{ q ? tl('No archived task matches.') : tl('No archived task.') }}</p>
      <ul class="archived-list">
        <li v-for="c in cards" :key="c.id"><TaskRow :row="row(c)" data-testid="archived-row" :data-task="c.id" @click="emit('pick', c)" /></li>
      </ul>
      <UButton v-if="cards.length < total" color="neutral" variant="outline" size="xl" class="archived-more" :loading="busy" data-testid="archived-more" @click="load(true)">
        {{ tl('Show more') }} <span class="mono-label">{{ total - cards.length }}</span>
      </UButton>
    </div>
  </AppSheet>
</template>

<style scoped>
.archived { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.archived-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
.archived-list li { display: flex; min-width: 0; border-bottom: 1px solid var(--line); }
.archived-more { align-self: center; }
</style>
