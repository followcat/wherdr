<script setup lang="ts">
// The whole pasted text in a scrolling window (sheet on the phone),
// monospace for a log, with Copy (a pasted-text AttachTile, in the field or a message).
import { lineCount, looksLikeLog } from '#shared/pastedText'

const props = defineProps<{ text: string }>()
const open = defineModel<boolean>('open', { default: false })
const lines = computed(() => lineCount(props.text))
const mono = computed(() => looksLikeLog(props.text))
const title = computed(() => tl(`Pasted text · ${lines.value} line${lines.value > 1 ? 's' : ''}`, `Texte collé · ${lines.value} ligne${lines.value > 1 ? 's' : ''}`))
async function copy() {
  try {
    await navigator.clipboard.writeText(props.text)
    toast(tl('Text copied', 'Texte copié'))
  } catch { toast(t('Copy failed'), true) }
}
</script>

<template>
  <AppSheet v-model:open="open" :title="title" wide tall>
    <pre class="pasted-full" :class="{ mono }">{{ text }}</pre>
    <template #footer>
      <div class="pasted-foot">
        <UButton icon="i-lucide-copy" color="neutral" variant="outline" @click="copy">{{ tl('Copy', 'Copier') }}</UButton>
      </div>
    </template>
  </AppSheet>
</template>
