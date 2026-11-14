<script setup lang="ts">
// "wherdr X.Y.Z is out" banner on the home screen: What's new (the release
// notes, rendered) and Update with Alfred (useUpdate.ts, updateWithAlfred).
import type { UpdateInfo } from '#shared/updates'

const props = defineProps<{ info: UpdateInfo, dismissible?: boolean }>()
const notesOpen = ref(false)
const notesHtml = computed(() => (props.info.notes ? md(props.info.notes, { doc: true }) : ''))
const busy = ref(false)

async function update() {
  haptic()
  busy.value = true
  try { await updateWithAlfred(props.info) } finally { busy.value = false }
}
</script>

<template>
  <div class="update-banner">
    <UIcon name="i-lucide-circle-arrow-up" class="update-banner-icon" />
    <div class="update-banner-body">
      <p>{{ tl(`wherdr ${info.latest} is out`) }}
        <small>{{ tl(`Installed: ${info.current}`) }}<template v-if="info.behind">
          · {{ info.behindAtLeast ? tl(`At least ${info.behind} newer releases`) : tl(`Newer releases: ${info.behind}`) }}
        </template></small>
        <small v-if="info.missed && info.missed.length > 1">{{ tl(`Other newer releases: ${info.missed.slice(1).join(', ')}`) }}</small>
      </p>
    </div>
    <UButton v-if="dismissible" size="sm" class="update-banner-hide" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="t('Hide until the next version')" @click="dismissUpdate" />
    <div class="update-banner-actions">
      <UButton v-if="info.notes" size="sm" color="neutral" variant="ghost" icon="i-lucide-sparkles" @click="notesOpen = true">{{ t('What\'s new') }}</UButton>
      <UButton v-else-if="info.url" size="sm" color="neutral" variant="ghost" icon="i-lucide-sparkles" :to="info.url" target="_blank" rel="noopener noreferrer">{{ t('What\'s new') }}</UButton>
      <UButton size="sm" color="primary" variant="soft" icon="i-lucide-circle-arrow-up" :loading="busy" @click="update">{{ t('Update with Alfred') }}</UButton>
    </div>
    <AppSheet v-model:open="notesOpen" :title="tl(`What's new in wherdr ${info.latest}`)" tall>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized by md() (utils/markdown.ts) -->
      <div class="md md-body update-notes" v-html="notesHtml" />
      <UButton v-if="info.url" class="update-notes-link" size="sm" color="neutral" variant="ghost" icon="i-lucide-external-link" :to="info.url" target="_blank" rel="noopener noreferrer">{{ t('Open on GitHub') }}</UButton>
      <template #footer>
        <div class="sheet-form">
          <UButton block size="xl" color="primary" class="hw-cta" icon="i-lucide-circle-arrow-up" :loading="busy" @click="notesOpen = false; update()">{{ t('Update with Alfred') }}</UButton>
        </div>
      </template>
    </AppSheet>
  </div>
</template>
