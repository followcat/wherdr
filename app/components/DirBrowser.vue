<script setup lang="ts">
// Folder browser of a machine: a tree of its folders under HOME, each listed
// the first time it opens (Git repositories marked), opened on the start
// folder; then "Choose this folder" (`choose`, the selected one) or `cancel`.
// At the top, the selected path is editable: paste/type a path + Enter opens it.
// Past 8 subfolders in the selected folder, a field filters them by name; Enter
// opens the first match.
import type { DirListing } from '#shared/types'
import type { TreeNode } from '~/components/FolderTree.vue'
import { normalizeDirInput } from '~/utils/dirInput'

const props = defineProps<{ start: string | null, machine: string }>()
const emit = defineEmits<{ choose: [path: string], cancel: [] }>()
const home = ref<string | null>(null)
const listings = ref<Record<string, DirListing>>({})
const listError = ref<string | null>(null)
const selected = ref<string | null>(null)
const tree = useTemplateRef<{ reveal: (keys: string[], select?: string) => Promise<void> }>('tree')
const pathInput = ref('')
const pathError = ref<string | null>(null)
const filter = ref('')
const shown = computed(() => (selected.value ? listings.value[selected.value] : undefined))

async function fetchDir(p: string | null) {
  return api<DirListing>(`/api/dirs?path=${encodeURIComponent(p || '')}${props.machine ? `&machine=${encodeURIComponent(props.machine)}` : ''}`)
}
async function load(key: string): Promise<TreeNode[]> {
  if (!key) return home.value ? [{ key: home.value, label: '~', icon: 'i-lucide-house', branch: true }] : []
  const l = listings.value[key] ?? await fetchDir(key)
  listings.value[key] = l
  if (l.denied) return [{ key: `${key}\ndenied`, label: l.denied === 'macos' ? tl('macOS blocks access to this folder', 'macOS bloque l’accès à ce dossier') : t('Permission denied'), note: 'info' }]
  return l.dirs.map(d => ({ key: d.path, label: d.name, branch: true, git: d.git }))
}
// The folders from HOME down to `path`, all opened.
function chain(path: string) {
  const h = home.value!
  if (!path.startsWith(`${h}/`)) return [h]
  const parts = path.slice(h.length + 1).split('/')
  return [h, ...parts.map((_, i) => `${h}/${parts.slice(0, i + 1).join('/')}`)]
}
const reveal = (l: DirListing) => tree.value?.reveal(chain(l.path), l.path)

// The start folder (or HOME when it cannot be read) gives HOME, then the tree opens on it.
async function begin() {
  let l: DirListing
  try { l = await fetchDir(props.start) }
  catch (err) {
    if (!props.start) { listError.value = (err as Error).message; return }
    try { l = await fetchDir(null) }
    catch (e) { listError.value = (e as Error).message; return }
  }
  listings.value[l.path] = l
  home.value = l.home
  await nextTick()
  reveal(l)
}
begin()
watch(selected, (p) => { pathInput.value = shortPath(p); pathError.value = null; filter.value = '' })

// Typed path: the tree stays in place as long as the new folder is not open;
// an error shows below the field, the sheet stays open.
const going = ref(false)
async function go() {
  // Before HOME is known, a typed path cannot be placed in the tree.
  if (!home.value) return
  const target = normalizeDirInput(pathInput.value.trim(), home.value)
  if (target === null) {
    pathError.value = tl(`This folder is outside this machine’s home folder (${shortPath(home.value)}).`, `Ce dossier est hors du dossier personnel (${shortPath(home.value)}) de cette machine.`)
    return
  }
  going.value = true
  try {
    const l = await fetchDir(target)
    listings.value[l.path] = l
    await reveal(l)
  } catch (err) {
    const e = err as ApiError
    pathError.value = e.code === 'bad_path'
      ? tl('Folder not found or unreadable on this machine.', 'Dossier introuvable ou illisible sur cette machine.')
      : e.message
  } finally { going.value = false }
}
function choose() {
  const p = selected.value ?? home.value
  if (p) emit('choose', p)
  else emit('cancel')
}
const show = (n: TreeNode, parent: string) => parent !== selected.value || filterByName([n], filter.value, x => x.label).length > 0
function openFirst() {
  const first = shown.value && filterByName(shown.value.dirs, filter.value, d => d.name)[0]
  if (first) tree.value?.reveal([first.path], first.path)
}
</script>

<template>
  <div class="dir-browser">
    <form class="dir-go" @submit.prevent="go">
      <input
        v-model="pathInput" class="dir-input" type="text" inputmode="url" enterkeyhint="go"
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
        :aria-label="tl('Folder path', 'Chemin du dossier')" placeholder="~/…"
        :aria-invalid="!!pathError" @input="pathError = null"
      >
      <UButton
        type="submit" size="sm" color="neutral" variant="outline" icon="i-lucide-arrow-right"
        :loading="going" :aria-label="tl('Go', 'Aller')" :title="tl('Go', 'Aller')"
      />
    </form>
    <p v-if="pathError" class="form-error dir-go-error">{{ pathError }}</p>
    <NameFilter
      v-if="shown && shown.dirs.length > 8" v-model="filter" class="dir-filter"
      :label="tl('Filter subfolders', 'Filtrer les sous-dossiers')" @pick="openFirst"
    />
    <div class="dir-list">
      <p v-if="listError" class="form-error">{{ listError }}</p>
      <div v-else-if="!home" class="term-loading static"><span class="spinner" /></div>
      <FolderTree v-else ref="tree" v-model:selected="selected" :load="load" :show="show" :empty="t('No subfolders.')">
        <template #trailing="{ node }"><span v-if="node.git" class="git">git</span></template>
      </FolderTree>
      <p v-if="shown?.dirs.length && filter && !filterByName(shown.dirs, filter, d => d.name).length" class="muted" role="status" style="padding:12px 8px">{{ tl('No matching subfolder.', 'Aucun sous-dossier correspondant.') }}</p>
      <div v-if="shown?.denied" class="dir-denied" role="status">
        <p class="dir-denied-label">
          <UIcon name="i-lucide-shield-alert" />{{ shown.denied === 'macos' ? tl('macOS blocks access to this folder', 'macOS bloque l’accès à ce dossier') : t('Permission denied') }}
        </p>
        <p v-if="shown.denied === 'macos' && shown.remote">
          {{ tl('On the Mac, allow it once:', 'Sur le Mac, autorise-le une fois :') }}
          <span class="dir-denied-path">{{ tl('System Settings › General › Sharing › Remote Login ⓘ › “Allow full disk access for remote users”', 'Réglages Système › Général › Partage › Session à distance ⓘ › « Autoriser l’accès complet au disque pour les utilisateurs distants »') }}</span>
        </p>
        <p v-else-if="shown.denied === 'macos'">
          {{ tl('On this Mac, allow the app that runs wherdr:', 'Sur ce Mac, autorise l’app qui fait tourner wherdr :') }}
          <span class="dir-denied-path">{{ tl('System Settings › Privacy & Security › Full Disk Access', 'Réglages Système › Confidentialité et sécurité › Accès complet au disque') }}</span>
        </p>
        <p v-else>{{ tl('This account cannot read this folder’s content.', 'Ce compte ne peut pas lire le contenu de ce dossier.') }}</p>
      </div>
    </div>
    <div class="dir-actions">
      <UButton color="neutral" variant="ghost" size="lg" block @click="emit('cancel')">{{ t('Cancel') }}</UButton>
      <UButton color="primary" variant="solid" size="lg" block class="hw-cta" @click="choose">{{ t('Choose this folder') }}</UButton>
    </div>
  </div>
</template>
