<script setup lang="ts">
// The notes (shared/notes.ts) under their filter, for NotesPanel.vue: each
// note's title and its few Markdown lines, read-only checkboxes and badges
// (NoteBadge.vue). Links: an in-app place opens in place (`leave` first),
// another note scrolls to it, a linked file (plans/x.md) opens rendered in
// its place with a back arrow. A link that leads nowhere, or out of the
// notes folder, is muted and does nothing.
import { h, render } from 'vue'
import { NOTES_FOLLOW, filterTab, noteBadges, noteTarget, notesShown, scopeName, type Note } from '#shared/notes'
import { appRoute, isAppLink } from '#shared/appLinks'
import NoteBadge from './NoteBadge.vue'

const emit = defineEmits<{ leave: [] }>()
const router = useRouter()
const items = computed(() => [
  { label: tl('Follow tab'), value: NOTES_FOLLOW },
  { label: tl('All'), value: 'all' },
  ...notesTabs.value.map(t => ({ label: t.name, value: t.scope })),
])
// A tab removed since it was picked: back to following the tab.
const filter = computed({
  get: () => (items.value.some(i => i.value === notesFilter.value) ? notesFilter.value : NOTES_FOLLOW),
  set: (v: string) => { notesFilter.value = v },
})
const shown = computed(() => notesShown(notes.value ?? [], filter.value, notesTab.value, machineGroups.value))
const scopeOf = (n: Note) => (n.scope === 'all' ? tl('All') : scopeName(n.scope, notesTabs.value, notesMachineName))
// The tab the list shows (followed or picked) and whether it has notes of its own.
const tab = computed(() => filterTab(filter.value, notesTab.value))
const tabName = computed(() => (tab.value ? scopeName(tab.value, notesTabs.value, notesMachineName) : ''))
const tabEmpty = computed(() => Boolean(tab.value && notes.value && !shown.value.some(n => n.scope === tab.value)))

// Each badge leaves a mark in the text, a slot in the HTML, then mounts there.
const rendered = computed(() => shown.value.map((n) => {
  const { text, badges } = noteBadges(n.body, i => `@@note-badge-${i}@@`)
  const html = md(text, { plain: true }).replace(/@@note-badge-(\d+)@@/g, (_, i: string) => `<span class="note-badge-slot" data-i="${i}"></span>`)
  return { note: n, html, badges }
}))
const app = getCurrentInstance()!.appContext
const list = ref<HTMLElement | null>(null)
let slots: Element[] = []
function mountBadges() {
  for (const s of slots) render(null, s)
  slots = []
  for (const r of rendered.value) {
    for (const slot of list.value?.querySelectorAll(`#note-${r.note.id} .note-badge-slot`) ?? []) {
      const badge = r.badges[Number((slot as HTMLElement).dataset.i)]
      if (!badge) continue
      const v = h(NoteBadge, { badge })
      v.appContext = app
      render(v, slot)
      slots.push(slot)
    }
  }
}

// The linked file open, its Markdown (null: missing), in place of the list.
const file = ref<{ path: string, text: string | null } | null>(null)
const fileHtml = computed(() => (file.value?.text == null ? '' : md(file.value.text, { doc: true })))
const view = ref<HTMLElement | null>(null)
let cameFrom = '' // the note whose link opened the file: back scrolls to it
async function back() {
  file.value = null
  await nextTick()
  if (cameFrom) list.value?.querySelector(`#${cameFrom}`)?.scrollIntoView({ block: 'nearest' })
}
// Each read of the notes (every few seconds while open) reads the open file
// again, so an agent's change shows without going back.
watch(noteFiles, async () => {
  const path = file.value?.path
  if (!path) return
  const text = await loadNoteFile(path)
  if (file.value?.path === path && file.value.text !== text) file.value = { path, text }
})
async function openFile(path: string) {
  const text = await loadNoteFile(path)
  file.value = { path, text }
  await nextTick()
  view.value?.scrollIntoView({ block: 'start' })
}
// Why a link from here (the list: '', or a file's path) leads nowhere, or ''.
const from = () => file.value?.path ?? ''
function missing(href: string, here = from()): string {
  const to = noteTarget(href, here)
  if (!to) return ''
  if (to.kind === 'out') return tl('Outside the notes folder')
  if (to.kind === 'note') return notes.value && !notes.value.some(n => n.id === to.id) ? tl('This note is missing') : ''
  return noteFiles.value && !noteFiles.value.includes(to.path) ? tl('This file is missing') : ''
}
function markLinks() {
  const links = [...list.value?.querySelectorAll('a[href]') ?? []].map(a => [a, ''] as [Element, string])
  for (const a of view.value?.querySelectorAll('.note-file-body a[href]') ?? []) links.push([a, from()])
  for (const [a, here] of links) {
    const why = missing(a.getAttribute('href') ?? '', here)
    a.classList.toggle('note-link-missing', Boolean(why))
    if (why) a.setAttribute('title', why)
    else a.removeAttribute('title')
  }
}
function refresh() { mountBadges(); markLinks() }
watch([rendered, file, notes, noteFiles], refresh, { flush: 'post' })
onMounted(refresh)
onBeforeUnmount(() => { for (const s of slots) render(null, s) })

async function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  const href = a?.getAttribute('href') ?? ''
  if (!a || /^[a-z][a-z0-9+.-]*:/i.test(href)) return // a web address: its new tab
  e.preventDefault()
  if (isAppLink(href)) {
    emit('leave')
    router.push(appRoute(href))
    return
  }
  const to = noteTarget(href, from())
  if (!to || missing(href)) return
  if (to.kind === 'file') {
    if (!file.value) cameFrom = a.closest('.note')?.id ?? ''
    return openFile(to.path)
  }
  if (to.kind !== 'note') return
  file.value = null
  await nextTick()
  list.value?.querySelector(`#note-${to.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}
</script>

<template>
  <div ref="view" class="notes-wrap" @click="onClick">
    <article v-if="file" class="note-file" data-testid="note-file">
      <header class="note-file-top">
        <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="tl('Back to notes')" :title="tl('Back to notes')" data-testid="note-file-back" @click="back" />
        <span class="mono-label">{{ file.path }}</span>
      </header>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized by md() (utils/markdown.ts) -->
      <div v-if="file.text != null" class="note-file-body md md-body" v-html="fileHtml" />
      <p v-else class="muted">{{ tl('This file is missing.') }}</p>
    </article>
    <div v-show="!file" class="notes-index">
      <USelect v-model="filter" :items="items" size="lg" class="notes-filter" :aria-label="tl('Notes shown')" data-testid="notes-filter" />
      <p v-if="filter === NOTES_FOLLOW && tab" class="muted notes-following" data-testid="notes-following">{{ tl(`${tabName} · following the tab`) }}</p>
      <div ref="list" class="notes-list">
        <p v-if="tabEmpty" class="muted notes-empty notes-tab-empty" data-testid="notes-tab-empty">{{ tl(`No notes for ${tabName} yet`) }}</p>
        <article v-for="r in rendered" :id="`note-${r.note.id}`" :key="r.note.id" class="note" data-testid="note">
          <h3><span>{{ r.note.title }}</span><small class="mono-label">{{ scopeOf(r.note) }}</small></h3>
          <!-- eslint-disable-next-line vue/no-v-html -- sanitized by md() (utils/markdown.ts) -->
          <div class="note-body md" v-html="r.html" />
        </article>
        <p v-if="notes && !shown.length && !tab" class="muted notes-empty">{{ tl('No notes here. Agents write them: ask Alfred to add a reminder.') }}</p>
      </div>
    </div>
  </div>
</template>
