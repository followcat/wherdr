<script setup lang="ts">
import type { FileEntry, FilePreview, FilesListing } from '#shared/types'
import type { TreeNode } from '~/components/FolderTree.vue'
import { findHeading, isMarkdownPath, resolveLink } from '~/utils/mdLinks'
import { MD_VIEW_KEY, SHOW_HIDDEN_KEY, readMdView, readShowHidden, writeShowHidden } from '~/utils/filesPrefs'
import type { MdView } from '~/utils/filesPrefs'

// Read-only browser of the agent's folder: a tree of its folders and files
// (each folder listed the first time it opens), and the file picked, beside it
// when there is room, else in its place with Back.
// `file`: one file only, a path as written in the conversation (ChatView's
// Preview), with no folder around it. inFolder: that file is a path relative to
// the agent's folder, read only there (an agent's `ui show file`). Any file
// shown can be downloaded.
// head: with `file`, the id of an element in the window's own header (under
// its title, the file's name): the file's folder · size, Back and its controls
// go there, so one file reads as a document under one header. `name` tells the
// window the name of the file shown (a link followed opens another one).
const props = defineProps<{ paneId: string, file?: string, inFolder?: boolean, head?: string }>()
const emit = defineEmits<{ name: [string] }>()
const written = computed(() => Boolean(props.file) && !props.inFolder)
const root = ref('')
const truncated = ref(false)
const selected = ref<string | null>(null)
const tree = useTemplateRef<{ reveal: (keys: string[], select?: string) => Promise<void>, reload: () => Promise<unknown> }>('tree')
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
const join = (dir: string, name: string) => dir ? `${dir}/${name}` : name
const fetchList = (dir: string | null) => api<FilesListing>(`/api/files?pane=${pane()}${dir === null ? '' : `&path=${encodeURIComponent(dir)}`}`)
// Listings already read, used once by the tree.
const early = new Map<string, FilesListing>()
let opened = false
async function list(dir: string): Promise<TreeNode[]> {
  let d = early.get(dir)
  early.delete(dir)
  if (!d && (dir || opened)) d = await fetchList(dir)
  else if (!d) {
    // First the pane's own folder: below the repository root, the tree shows
    // the root and opens down to it.
    opened = true
    const own = await fetchList(null)
    d = own.path ? await fetchList('') : own
    if (own.path) {
      early.set(own.path, own)
      tree.value?.reveal(chain(own.path))
    }
  }
  if (!dir) root.value = d.root
  if (d.truncated) truncated.value = true
  // Keys from the path the server answered for.
  const at = d.path
  return d.entries.map(e => ({ key: join(at, e.name), label: e.name, icon: icon(e), tone: e.kind, branch: e.kind === 'dir', disabled: e.kind === 'other', size: e.kind === 'file' ? e.size : null }))
}
const visible = (n: TreeNode) => showHidden.value || !n.label.startsWith('.')
// The folders from the top down to `dir`, all opened.
const chain = (dir: string) => dir ? dir.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')) : []
function pick(n: TreeNode) {
  if (!n.branch) openFile(n.key)
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
// An HTML page (an agent's mockup or demo) runs in a sandboxed frame
// (Preview), served with its own policy (server/utils/fileDownload.ts): an
// opaque origin, away from wherdr's cookies, storage and API. Or its source.
// A page cut at the text limit stays source only.
const htmlView = ref<'preview' | 'source'>('preview')
const isHtml = computed(() => preview.value?.kind === 'text' && /\.html?$/i.test(preview.value.path))
const isPage = computed(() => isHtml.value && !preview.value!.truncated)
watch(() => preview.value?.path, (p) => { if (p) emit('name', p.split('/').pop() || p) })
// The file's folder · size, under the window's title.
const located = computed(() => {
  const p = preview.value
  if (!p) return ''
  const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) || '/' : ''
  return [dir, fmtBytes(p.size)].filter(Boolean).join(' · ')
})
const pageShown = computed(() => isPage.value && htmlView.value === 'preview')
// Preview and Open share the authenticated inline download path.
// Each refresh reloads it.
const reloads = ref(0)
const inlineUrl = computed(() => preview.value?.kind === 'pdf' || preview.value?.kind === 'video' || isPage.value ? `/api/files/download?${fileQuery(preview.value!.path)}&inline=1` : '')
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
  else {
    tree.value?.reload()
    if (preview.value) openFile(preview.value.path)
  }
}
onMounted(() => { if (props.file) openFile(props.file) })
onUnmounted(() => { request++ })

// Breadcrumb: root folder name, then each folder down to the file shown.
const crumbs = computed(() => {
  if (props.file || !root.value) return []
  const parts = preview.value ? chain(preview.value.path).slice(0, -1) : []
  return [{ label: root.value.split('/').filter(Boolean).pop() || '/', path: '' }, ...parts.map(p => ({ label: p.split('/').pop()!, path: p }))]
})
function openFolder(dir: string) {
  back()
  if (dir) tree.value?.reveal(chain(dir), dir)
}
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
// Rendered | Source of a Markdown file, Preview | Source of a page.
const views = computed(() => isMd.value
  ? [{ label: t('Rendered'), value: 'rendered' }, { label: t('Source'), value: 'source' }]
  : isPage.value ? [{ label: t('Preview'), value: 'preview' }, { label: t('Source'), value: 'source' }] : null)
const view = computed({
  get: () => isMd.value ? mdView.value : htmlView.value,
  set: (v: string) => {
    if (!v) return
    if (isMd.value) mdView.value = v as MdView
    else htmlView.value = v as 'preview' | 'source'
  },
})
const rendered = computed(() => isMd.value && mdView.value === 'rendered' ? md(preview.value!.text ?? '', { doc: true }) : '')
const top = ref<HTMLElement | null>(null)
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

// A tap in the document: an image enlarged, Copy on a code block, an anchor of the page, or a
// relative link to another file of the folder, opened here. Web links open
// in a new tab (the renderer's target="_blank").
function onDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  // An image of the document: the zoomable viewer, through all of its images.
  if (target instanceof HTMLImageElement && target.src && !target.closest('a[href]')) {
    const srcs = Array.from(doc.value?.querySelectorAll<HTMLImageElement>('img') ?? []).map(i => i.src).filter(Boolean)
    openLightbox(srcs, srcs.indexOf(target.src))
    return
  }
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
    if (!props.file) openFolder(to.path)
  } else {
    followFile(from, to.path, to.anchor)
  }
}
async function followFile(from: string, path: string, anchor: string) {
  if (props.file) trail.value.push(from)
  pendingAnchor = anchor || null
  // The tree follows the file into its folder.
  if (!props.file) tree.value?.reveal(chain(path).slice(0, -1), path)
  await openFile(path)
  if (!anchor) top.value?.scrollIntoView({ block: 'start' })
}

// Folders, links, then the file's type by its extension.
const TYPES: [RegExp, string][] = [
  [/\.(md|markdown|txt|rst)$/i, 'i-lucide-file-text'],
  [/\.(png|jpe?g|gif|webp|avif|svg|ico)$/i, 'i-lucide-file-image'],
  [/\.(mp4|mov|webm|m4v)$/i, 'i-lucide-file-video'],
  [/\.(json|ya?ml|toml|lock)$/i, 'i-lucide-file-json'],
  [/\.(zip|tar|gz|tgz|xz|7z)$/i, 'i-lucide-file-archive'],
  [/\.([cm]?[jt]sx?|vue|py|rb|rs|go|sh|css|html?|c|h|cpp|java|kt|swift)$/i, 'i-lucide-file-code'],
]
function icon(e: FileEntry) {
  if (e.kind === 'dir') return e.link ? 'i-lucide-folder-symlink' : 'i-lucide-folder'
  if (e.kind === 'other') return 'i-lucide-file-question'
  if (e.link) return 'i-lucide-file-symlink'
  return TYPES.find(([re]) => re.test(e.name))?.[1] ?? 'i-lucide-file'
}
</script>

<template>
  <div class="changes-view files-view" :class="{ single: file }">
    <div ref="top" class="changes-inner">
      <Teleport defer :to="head ? `#${head}` : 'body'" :disabled="!file || !head">
        <div class="changes-toolbar files-bar">
          <nav class="files-crumbs" :aria-label="t('Folder')">
            <UButton v-if="preview && (!file || trail.length)" icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="sm" :aria-label="t('Back to folder')" @click="back" />
            <span v-if="file" class="files-located" data-testid="files-located">{{ located }}</span>
            <template v-for="(c, i) in crumbs" :key="c.path">
              <span v-if="i" class="files-sep">/</span>
              <button type="button" class="files-crumb" @click="openFolder(c.path)">{{ c.label }}</button>
            </template>
            <template v-if="preview && !file">
              <span v-if="crumbs.length" class="files-sep">/</span><span class="files-crumb current">{{ preview.path.split('/').pop() }}</span>
            </template>
          </nav>
          <div class="files-actions">
            <UToggleGroup v-if="views" v-model="view" :items="views" :aria-label="isMd ? t('Markdown view') : t('Page view')" class="hw-seg files-md-mode" />
            <UButton v-if="inlineUrl" icon="i-lucide-external-link" color="neutral" variant="outline" size="sm" :to="inlineUrl" target="_blank" external :aria-label="t('Open')" :title="t('Open')"><span class="files-label">{{ t('Open') }}</span></UButton>
            <UButton v-if="preview" icon="i-lucide-download" color="neutral" variant="outline" size="sm" :loading="downloading" :aria-label="t('Download')" :title="t('Download')" @click="download"><span class="files-label">{{ t('Download') }}</span></UButton>
            <UButton icon="i-lucide-refresh-cw" color="neutral" variant="outline" size="sm" :loading="loading" :aria-label="t('Refresh')" :title="t('Refresh')" @click="refresh"><span class="files-label">{{ t('Refresh') }}</span></UButton>
          </div>
        </div>
      </Teleport>

      <p v-if="error" class="changes-notice error" role="alert">{{ error }}</p>
      <div class="files-split" :class="{ previewing: preview && !file }">
        <section v-if="!file" class="files-tree">
          <label class="changes-toggle"><input v-model="showHidden" type="checkbox"> <span>{{ t('Show hidden files') }}</span></label>
          <p v-if="truncated" class="changes-limit">{{ t('File list or diff limited to keep this view responsive.') }}</p>
          <FolderTree ref="tree" v-model:selected="selected" :load="list" :show="visible" :empty="t('Empty folder.')" @pick="pick">
            <template #trailing="{ node }"><span v-if="node.size != null" class="change-status">{{ fmtBytes(node.size as number) }}</span></template>
          </FolderTree>
        </section>
        <section v-if="preview || (loading && file)" class="files-preview">
          <p v-if="!preview" class="changes-notice"><span class="spinner" /> {{ t('Reading files…') }}</p>
          <template v-else>
            <p v-if="!file" class="changes-location">{{ preview.path }} · {{ fmtBytes(preview.size) }}</p>
            <p v-if="preview.truncated && preview.kind === 'text'" class="changes-limit">{{ t('File truncated to keep this view responsive.') }}</p>
            <template v-if="pageShown">
              <!-- Never allow-same-origin, popups, forms or top navigation. -->
              <iframe :key="`${inlineUrl}:${reloads}`" class="files-page" :src="inlineUrl" sandbox="allow-scripts" referrerpolicy="no-referrer" :title="preview.path" />
              <p class="files-page-note">{{ t('Self-contained pages only: files next to it are not loaded; https scripts, styles and images are.') }}</p>
            </template>
            <button v-else-if="preview.kind === 'image'" type="button" class="files-image-open" :aria-label="t('Enlarge image')" @click="preview.dataUrl && openLightbox([preview.dataUrl])">
              <img class="files-image" :src="preview.dataUrl" :alt="preview.path">
            </button>
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
        </section>
      </div>
    </div>
  </div>
</template>
