<script setup lang="ts">
const open = shortcutsOpen
</script>

<template>
  <AppSheet v-model:open="open" :title="tl('Keyboard shortcuts', 'Raccourcis clavier')" tall screen>
    <ShortcutsReference />
  </AppSheet>
</template>
