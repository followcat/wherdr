<script setup lang="ts">
import type { FileEntry, FilePreview, FilesListing } from '#shared/types'
import { findHeading, isMarkdownPath, resolveLink } from '~/utils/mdLinks'
import { MD_VIEW_KEY, SHOW_HIDDEN_KEY, readMdView, readShowHidden, writeShowHidden } from '~/utils/filesPrefs'
import type { MdView } from '~/utils/filesPrefs'

// Read-only browser of the agent's folder: listing, then a file's text or image.
// `file`: one file only, a path as written in the conversation (ChatView's
// Preview), with no folder around it. inFolder: that file is a path relative to
// the agent's folder, read only there (an agent's `ui show file`). Any file
// shown can be downloaded.
const props = defineProps<{ paneId: string, file?: string, inFolder?: boolean }>()
const written = computed(() => Boolean(props.file) && !props.inFolder)
const listing = ref<FilesListing | null>(null)
const preview = ref<FilePreview | null>(null)
const loading = ref(false)
const error = ref('')
const showHidden = syncedRef(SHOW_HIDDEN_KEY, readShowHidden, writeShowHidden)
let request = 0

const pane = () => encodeURIComponent(props.paneId)
async function load<T>(url: string, apply: (data: T) => void) {
  const id = ++request
  loading.value = true
  error.value = ''
  try {
    const data = await api<T>(url)
    if (id === request) apply(data)
  } catch (e) {
    if (id === request) error.value = (e as Error).message
  } finally {
    if (id === request) loading.value = false
  }
}
function openDir(path: string | null) {
  const q = path === null ? '' : `&path=${encodeURIComponent(path)}`
  return load<FilesListing>(`/api/files?pane=${pane()}${q}`, (d) => { listing.value = d; preview.value = null })
}
const fileQuery = (path: string) => `pane=${pane()}&path=${encodeURIComponent(path)}${written.value ? '&from=chat' : ''}`
// The file asked for last, as asked (a conversation's "~/…" stays so).
let shown = ''
function openFile(path: string) {
  shown = path
  return load<FilePreview>(`/api/files/read?${fileQuery(path)}`, (d) => { preview.value = d })
}
// A file opened from a link of a Markdown file: the anchor to show once it is
// loaded, and the files to come back to (Back) when there is no folder around.
let pendingAnchor: string | null = null
const trail = ref<string[]>([])
// Preview and Open share the authenticated inline download path.
// Each refresh reloads it.
const reloads = ref(0)
const inlineUrl = computed(() => preview.value?.kind === 'pdf' || preview.value?.kind === 'video' ? `/api/files/download?${fileQuery(preview.value.path)}&inline=1` : '')
// A video the browser cannot decode (codec, or a .mov outside Safari): say so,
// Open and Download stay.
const videoFailed = ref(false)
watch(inlineUrl, () => { videoFailed.value = false })
const downloading = ref(false)
async function download() {
  const p = preview.value?.path
  if (!p || downloading.value) return
  downloading.value = true
  try { await saveFile(`/api/files/download?${fileQuery(p)}`, p.split('/').pop() || p) }
  catch (e) { toast((e as Error).message, true) }
  finally { downloading.value = false }
}
const join = (name: string) => listing.value?.path ? `${listing.value.path}/${name}` : name
function open(e: FileEntry) {
  if (e.kind === 'dir') openDir(join(e.name))
  else if (e.kind === 'file') openFile(join(e.name))
}
// Back to the folder: a preview still loading must not reopen afterwards.
function back() {
  request++
  loading.value = false
  const previous = props.file ? trail.value.pop() : undefined
  if (previous) openFile(previous)
  else preview.value = null
}
function refresh() {
  reloads.value++
  images.clear()
  // Same URL: the player comes back with its new key.
  videoFailed.value = false
  if (props.file) openFile(shown || props.file)
  else if (preview.value) openFile(preview.value.path)
  else openDir(listing.value ? listing.value.path : null)
}
onMounted(() => props.file ? openFile(props.file) : openDir(null))
onUnmounted(() => { request++ })

// Breadcrumb: root folder name, then each segment of the current path.
const crumbs = computed(() => {
  const l = listing.value
  if (!l) return []
  const parts = l.path ? l.path.split('/') : []
  return [
    { label: l.root.split('/').filter(Boolean).pop() || '/', path: '' },
    ...parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join('/') })),
  ]
})
const entries = computed(() => (listing.value?.entries || []).filter(e => showHidden.value || !e.name.startsWith('.')))
// Text and line numbers as two blocks: a 256 kB file stays two elements.
const code = computed(() => {
  const raw = preview.value?.text ?? ''
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  let count = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++
  return { text, numbers: Array.from({ length: count }, (_, i) => i + 1).join('\n') }
})

// A Markdown file is shown formatted (the conversation's renderer, in its
// file mode: utils/markdown.ts) or as its source with line numbers.
const mdView = syncedRef<MdView>(MD_VIEW_KEY, readMdView, v => v)
const isMd = computed(() => preview.value?.kind === 'text' && isMarkdownPath(preview.value.path))
const rendered = computed(() => isMd.value && mdView.value === 'rendered' ? md(preview.value!.text ?? '', { doc: true }) : '')
const root = ref<HTMLElement | null>(null)
const doc = ref<HTMLElement | null>(null)

// Images written with a relative path are read from the folder, like any
// previewed image (2 MB at most each); a path leading out of it stays empty.
const MAX_IMAGES = 40
// Kept for the file shown only (toggles, refresh of the source), not beyond.
const images = new Map<string, string | null>()
let imagesOf = ''
let imageRun = 0
async function loadImages(el: HTMLElement, from: string) {
  const run = ++imageRun
  if (imagesOf !== from) images.clear()
  imagesOf = from
  const absolute = written.value
  for (const img of Array.from(el.querySelectorAll<HTMLImageElement>('img[data-src]')).slice(0, MAX_IMAGES)) {
    const target = resolveLink(from, img.dataset.src || '', absolute)
    if (target?.kind !== 'file') continue
    let url = images.get(target.path)
    if (url === undefined) {
      try {
        const p = await api<FilePreview>(`/api/files/read?${fileQuery(target.path)}`)
        url = p.kind === 'image' && p.dataUrl ? p.dataUrl : null
      } catch { url = null }
      images.set(target.path, url)
    }
    if (run !== imageRun) return
    if (url) img.src = url
  }
}
// Each file read is a new document (its own DOM, its images read again), even
// when its text is the same as the previous one's: Refresh, or another file.
const readSerial = ref(0)
watch(preview, () => { readSerial.value++ })
watch([rendered, doc, readSerial], async ([html, el]) => {
  imageRun++
  if (!html || !el || !preview.value) return
  await nextTick()
  const anchor = pendingAnchor
  pendingAnchor = null
  if (anchor) findHeading(el, anchor)?.scrollIntoView({ block: 'start' })
  loadImages(el, preview.value.path)
}, { flush: 'post' })

// A tap in the document: Copy on a code block, an anchor of the page, or a
// relative link to another file of the folder, opened here. Web links open
// in a new tab (the renderer's target="_blank").
function onDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const copy = target.closest?.('.code-copy') as HTMLElement | null
  if (copy) {
    const text = copy.closest('.code-block')?.querySelector('pre')?.textContent
    if (text == null) return
    copyCodeBlock(copy, text)
    return
  }
  const a = target.closest?.('a[href]') as HTMLAnchorElement | null
  const from = preview.value?.path
  if (!a || !from) return
  const to = resolveLink(from, a.getAttribute('href') || '', written.value)
  if (!to || to.kind === 'external') return
  e.preventDefault()
  if (to.kind === 'anchor') {
    if (doc.value) findHeading(doc.value, to.anchor)?.scrollIntoView({ block: 'start' })
  } else if (to.kind === 'outside') {
    toast(t('This link leads outside the folder.'), true)
  } else if (to.kind === 'dir') {
    if (!props.file) openDir(to.path)
  } else {
    followFile(from, to.path, to.anchor)
  }
}
async function followFile(from: string, path: string, anchor: string) {
  // The breadcrumb follows the file into its folder.
  const dir = path.split('/').slice(0, -1).join('/')
  const folder = props.file || listing.value?.path === dir
    ? null
    : api<FilesListing>(`/api/files?pane=${pane()}&path=${encodeURIComponent(dir)}`).catch(() => null)
  if (props.file) trail.value.push(from)
  pendingAnchor = anchor || null
  await openFile(path)
  const d = await folder
  if (d && preview.value?.path === path) listing.value = d
  if (!anchor) root.value?.scrollIntoView({ block: 'start' })
}

function icon(e: FileEntry) {
  if (e.kind === 'dir') return e.link ? 'i-lucide-folder-symlink' : 'i-lucide-folder'
  if (e.kind === 'other') return 'i-lucide-file-question'
  return e.link ? 'i-lucide-file-symlink' : 'i-lucide-file'
}
</script>

<template>
  <div class="changes-view files-view">
    <div ref="root" class="changes-inner">
      <div class="changes-toolbar">
        <nav class="files-crumbs" :aria-label="t('Folder')">
          <UButton v-if="preview && (!file || trail.length)" icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="sm" :aria-label="t('Back to folder')" @click="back" />
          <template v-for="(c, i) in crumbs" :key="c.path">
            <span v-if="i" class="files-sep">/</span>
            <button type="button" class="files-crumb" @click="openDir(c.path)">{{ c.label }}</button>
          </template>
          <template v-if="preview">
            <span v-if="crumbs.length" class="files-sep">/</span><span class="files-crumb current">{{ preview.path.split('/').pop() }}</span>
          </template>
        </nav>
        <div class="files-actions">
          <UButton v-if="inlineUrl" icon="i-lucide-external-link" color="neutral" variant="outline" size="sm" :to="inlineUrl" target="_blank" external :aria-label="t('Open')">{{ t('Open') }}</UButton>
          <UButton v-if="preview" icon="i-lucide-download" color="neutral" variant="outline" size="sm" :loading="downloading" :aria-label="t('Download')" @click="download">{{ t('Download') }}</UButton>
          <UButton icon="i-lucide-refresh-cw" color="neutral" variant="outline" size="sm" :loading="loading" :aria-label="t('Refresh')" @click="refresh"><span class="files-label">{{ t('Refresh') }}</span></UButton>
        </div>
      </div>

      <p v-if="error" class="changes-notice error" role="alert">{{ error }}</p>
      <p v-if="loading && !listing && !preview" class="changes-notice"><span class="spinner" /> {{ t('Reading files…') }}</p>

      <template v-else-if="preview">
        <p class="changes-location">{{ preview.path }} · {{ fmtBytes(preview.size) }}</p>
        <div v-if="isMd" class="segmented files-md-mode" role="group" :aria-label="t('Markdown view')" style="--segment-count: 2">
          <button v-for="v in (['rendered', 'source'] as const)" :key="v" type="button" :class="{ on: mdView === v }" :aria-pressed="mdView === v" @click="mdView = v">
            <span>{{ v === 'rendered' ? t('Rendered') : t('Source') }}</span>
          </button>
        </div>
        <p v-if="preview.truncated && preview.kind === 'text'" class="changes-limit">{{ t('File truncated to keep this view responsive.') }}</p>
        <img v-if="preview.kind === 'image'" class="files-image" :src="preview.dataUrl" :alt="preview.path">
        <PdfPreview v-else-if="preview.kind === 'pdf'" :key="`${inlineUrl}:${reloads}`" :src="inlineUrl" :title="preview.path" />
        <template v-else-if="preview.kind === 'video'">
          <p v-if="videoFailed" class="changes-notice" role="alert">{{ t('This video cannot be played here. Use Open or Download.') }}</p>
          <!-- Streamed in pieces (Range); playsinline: no forced full screen on iPhone. -->
          <video v-else :key="`${inlineUrl}:${reloads}`" class="files-video" :src="inlineUrl" :aria-label="preview.path" controls playsinline preload="metadata" @error="videoFailed = true" />
        </template>
        <p v-else-if="preview.kind === 'binary'" class="changes-notice">{{ t('Binary file') }}</p>
        <p v-else-if="preview.kind === 'large'" class="changes-notice">{{ /\.pdf$/i.test(preview.path) ? t('PDF too large to preview (50 MB max).') : t('Image too large to preview.') }}</p>
        <!-- eslint-disable-next-line vue/no-v-html -- sanitised by utils/markdown.ts -->
        <article v-else-if="rendered" :key="readSerial" ref="doc" class="md md-body files-md" :aria-label="preview.path" @click="onDocClick" v-html="rendered" />
        <div v-else class="files-code" role="region" :aria-label="preview.path">
          <pre class="files-num" aria-hidden="true">{{ code.numbers }}</pre><pre class="files-text">{{ code.text }}</pre>
        </div>
      </template>

      <template v-else-if="listing">
        <label class="changes-toggle"><input v-model="showHidden" type="checkbox"> <span>{{ t('Show hidden files') }}</span></label>
        <p v-if="listing.truncated" class="changes-limit">{{ t('File list or diff limited to keep this view responsive.') }}</p>
        <p v-if="!entries.length" class="changes-notice">{{ t('Empty folder.') }}</p>
        <ul class="files-list">
          <li v-for="e in entries" :key="e.name">
            <button type="button" class="change-file files-entry" :disabled="e.kind === 'other'" @click="open(e)">
              <UIcon :name="icon(e)" class="files-icon" :class="e.kind" />
              <span class="change-path">{{ e.name }}</span>
              <span v-if="e.kind === 'file' && e.size !== null" class="change-status">{{ fmtBytes(e.size) }}</span>
              <UIcon v-if="e.kind === 'dir'" name="i-lucide-chevron-right" class="files-chevron" />
            </button>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>
