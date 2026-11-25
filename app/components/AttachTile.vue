<script setup lang="ts">
// One attachment of the message field as a square tile (UChatAttachment,
// vertical), the same for a photo, a file and pasted text: a preview on top
// (the photo cropped to fill, a text's first lines in small mono, an icon for
// a PDF or other binary file), then a mono badge with the extension, the name
// and the size or line count; the remove cross in the corner (`sent`: none,
// in a sent message). Styles: main.css `.att-tile`, app.config.ts `chatAttachment`.
const props = withDefaults(defineProps<{
  name: string
  badge: string
  description?: string
  status?: 'idle' | 'uploading' | 'error'
  url?: string // a photo
  text?: string // the first lines of a text
  icon?: string
  label?: string // a tap opens it (photo, pasted text, a sent file's menu)
  sent?: boolean
}>(), { status: 'idle' })
const emit = defineEmits<{ remove: [], open: [el: HTMLElement] }>()
// A tap on the remove cross is not a tap on the tile.
function open(e: Event) {
  if (props.label && !(e.target as Element | null)?.closest('[data-slot="remove"]')) emit('open', e.currentTarget as HTMLElement)
}
</script>

<template>
  <!-- UChatAttachment has no slot for a text preview or a badge: both lie over its preview area. -->
  <div
    class="att-tile" :class="{ 'has-text': text && status !== 'error', 'has-photo': url, openable: label }" :data-status="status"
    :title="status === 'error' ? description : name" v-bind="label ? { 'role': 'button', 'tabindex': 0, 'aria-label': label } : {}"
    @click="open" @keydown.enter.self="open"
  >
    <UChatAttachment
      orientation="vertical" :name="name" :type="url ? 'image/*' : undefined" :url="url" :description="description" :status="status"
      :icon="icon" loading-icon="i-lucide-loader" error-icon="i-lucide-triangle-alert" :removable="!sent" @remove="emit('remove')"
    />
    <pre v-if="text && status !== 'error'" class="att-tile-text" aria-hidden="true">{{ text }}</pre>
    <span class="att-tile-badge">{{ badge }}</span>
  </div>
</template>
