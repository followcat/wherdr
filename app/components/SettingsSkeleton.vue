<script setup lang="ts">
// A Settings section's data while it loads: the shapes of what comes, never a
// default shown as if it were the value (an off switch, an empty list). `rows`
// draws that many rows of a settings card; `switch` the block a switch takes.
// With `error`, the load failed: the message and Try again (`retry`), no shapes.
withDefaults(defineProps<{ kind?: 'rows' | 'switch', rows?: number, error?: string }>(), { kind: 'rows', rows: 3, error: '' })
defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="error" class="skel-error" data-testid="load-error">
    <p class="form-error" role="alert">{{ t(error) }}</p>
    <UButton color="neutral" variant="outline" size="lg" icon="i-lucide-rotate-cw" data-testid="load-retry" @click="$emit('retry')">{{ tl('Try again') }}</UButton>
  </div>
  <span v-else-if="kind === 'switch'" class="skel skel-switch" role="status" :aria-label="tl('Loading')" data-testid="skeleton-switch" />
  <div v-else class="settings-card skel-card" role="status" :aria-label="tl('Loading')" aria-busy="true">
    <div v-for="n in rows" :key="n" class="skel-row" data-testid="skeleton-row">
      <i class="skel" style="width: 38%" /><i class="skel skel-small" style="width: 26%" /><i class="skel skel-small" :style="{ width: `${64 - n * 9}%` }" />
    </div>
  </div>
</template>

<style scoped>
/* .skel (main.css): muted, square, a gentle pulse (none with reduced motion). */
.skel-switch { flex: none; width: 48px; height: 28px; }
.skel-card { display: grid; padding: 0; }
/* A project row's height: its padding and three lines (name, key, path). */
.skel-row { display: grid; gap: 8px; padding: 17px 16px; border-bottom: 1px solid var(--line); }
.skel-row:last-child { border-bottom: 0; }
.skel-row i { height: 14px; }
.skel-row .skel-small { height: 11px; }
.skel-error { display: grid; justify-items: start; gap: 8px; margin-top: 8px; }
</style>
