<script setup lang="ts">
// The attachments of a user message, on their own row above its bubble (never
// inside it), on the bubble's side: the photos as plain thumbnails (MsgThumbs:
// grid, "+N", viewer on the whole set), then each file and each long pasted
// text as the message field's tile (AttachTile). A file's tap opens the path
// menu; a pasted text's opens the whole text with Copy (PastedSheet).
import { fileTile, pasteTile, sentSplit } from '~/utils/attachTiles'

const props = defineProps<{
  srcs: string[]
  files: { path: string, name: string }[]
  text: string
  pasted?: string[]
  missing?: number // photos counted by Claude's queue whose file wherdr does not know
  offline?: boolean
}>()
const emit = defineEmits<{ file: [el: HTMLElement, path: string] }>()
const pastes = computed(() => sentSplit(props.text, props.pasted).pastes)
const opened = ref<string | null>(null)
</script>

<template>
  <div v-if="srcs.length || missing || files.length || pastes.length" class="msg-atts">
    <MsgThumbs v-if="srcs.length" :srcs="srcs" :offline="offline" />
    <span v-for="k in missing || 0" :key="`m${k}`" class="thumb-missing" :title="t('Image')"><UIcon name="i-lucide-image" /></span>
    <AttachTile v-for="f in files" :key="f.path" v-bind="fileTile(f.name)" :label="f.name" sent @open="el => emit('file', el, f.path)" />
    <AttachTile v-for="(p, i) in pastes" :key="`p${i}`" v-bind="pasteTile(p)" sent @open="opened = p" />
    <PastedSheet v-if="pastes.length" :open="opened !== null" :text="opened || ''" @update:open="(o: boolean) => { if (!o) opened = null }" />
  </div>
</template>
