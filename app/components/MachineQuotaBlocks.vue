<script setup lang="ts">
// Machine quotas below the shared ones (quotaBlocks): one block per account,
// its name as title and the machines sharing it as small chips under it.
import type { QuotaBlock } from '~/utils/quotas'

defineProps<{ blocks: QuotaBlock[] }>()
</script>

<template>
  <div v-for="b in blocks" :key="b.key" class="state-machine-quotas" :data-account="b.key">
    <p class="state-machine-quotas-label">{{ b.title }}</p>
    <ul v-if="b.machines.length" class="state-machine-quotas-machines" :aria-label="tl('Machines on this account', 'Machines de ce compte')">
      <li v-for="name in b.machines" :key="name">{{ name }}</li>
    </ul>
    <QuotaStrip :rows="b.rows" :api="b.api" class="machine-quotas" />
  </div>
</template>
