<script setup lang="ts">
// State of an agent, in the style of herdr.dev's "agents" list:
// colored dot + mono "working · claude" line (+ "· opus 5.5" with `model`).
import type { Pane } from '#shared/types'

defineProps<{ pane: Pane | null | undefined, kind?: boolean, model?: boolean, compact?: boolean }>()
</script>

<template>
  <span v-if="pane" class="pill" :class="statusKey(pane)"><i /><span v-if="compact" class="pill-label">{{ statusLabel(pane) }}</span><template v-else>{{ statusLabel(pane) }}</template><template v-if="kind && pane.agent"><span class="sep">·</span><span class="pill-kind" :class="pane.agent">{{ pane.agent }}</span></template><template v-if="model && pane.model"><span class="sep">·</span><span class="pill-model">{{ pane.model.label }}</span><span v-if="pane.model.effort" class="pill-effort">{{ pane.model.effort }}</span></template></span>
  <span v-else class="pill unknown"><i />{{ t('Closed') }}</span>
</template>
