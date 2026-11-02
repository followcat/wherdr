<template>
  <SettingsView />
</template>
<script setup lang="ts">
definePageMeta({ alias: ['/settings/desktop'] })
onMounted(() => { curPane.value = null })
</script>
