<script setup lang="ts">
// "wherdr X.Y.Z is available" banner: link to the release notes, and either
// the Update button (one-tap update, when this installation and this session
// allow it) or the update command for the installation mode.
import type { UpdateInfo } from '#shared/updates'

const props = defineProps<{ info: UpdateInfo, dismissible?: boolean }>()

async function copy() {
  haptic()
  try {
    await navigator.clipboard.writeText(props.info.command)
    toast(t('Command copied: paste it into a terminal on the server, in the wherdr folder.'))
  } catch { toast(t('Copy failed'), true) }
}

function update() {
  haptic()
  runSelfUpdate(props.info)
}
</script>

<template>
  <div class="update-banner">
    <UIcon name="i-lucide-circle-arrow-up" class="update-banner-icon" />
    <div class="update-banner-body">
      <p>{{ tl(`wherdr ${info.latest} is available`, `wherdr ${info.latest} est disponible`) }}<small>{{ tl(`Installed: ${info.current}`, `Version installée : ${info.current}`) }}<template v-if="info.behind"> · 落后 {{ info.behind }} 个版本</template></small>
        <small v-if="info.behind > 1" class="update-behind-list">跳过版本：{{ info.missed.slice(1).join('、') }}</small></p>
      <template v-if="!info.oneTap">
        <code>{{ info.command }}</code>
        <small v-if="info.mode === 'native'">{{ t('Then restart wherdr.') }}</small>
        <small v-else-if="info.mode === 'npm'">{{ t('Stop wherdr first, then run this command.') }}</small>
      </template>
    </div>
    <div class="update-banner-actions">
      <UButton v-if="info.oneTap" size="sm" color="primary" variant="solid" icon="i-lucide-download" @click="update">{{ t('Update') }}</UButton>
      <UButton v-if="info.url" size="sm" color="neutral" variant="ghost" icon="i-lucide-external-link" :to="info.url" target="_blank" rel="noopener noreferrer">{{ t('Release notes') }}</UButton>
      <UButton v-if="!info.oneTap" size="sm" color="neutral" variant="ghost" icon="i-lucide-copy" @click="copy">{{ t('Copy command') }}</UButton>
      <UButton v-if="dismissible" size="sm" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="t('Hide until the next version')" @click="dismissUpdate" />
    </div>
  </div>
</template>
