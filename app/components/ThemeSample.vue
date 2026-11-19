<script setup lang="ts">
// A theme's palette at work and its WCAG AA contrast check: a few rows, a message
// and a button in a proposed theme's card; the whole app in miniature (ThemePreview)
// in the theme editor (`full`).
import type { ThemeVariant } from '~/utils/themes'

const props = defineProps<{ variant: ThemeVariant, full?: boolean }>()
const issues = computed(() => contrastIssues(props.variant.c))
</script>

<template>
  <div>
    <ThemePreview v-if="full" :variant="variant" />
    <div v-else class="te-preview" :style="themeVars(variant)" data-testid="theme-preview">
      <div class="te-row"><i class="te-sq working" /><b>api-server</b><small>{{ tl('Working') }}</small></div>
      <div class="te-row"><i class="te-sq blocked" /><b>docs</b><small>{{ tl('Your turn') }}</small></div>
      <p class="te-user">{{ tl('Can you fix the failing test?') }}</p>
      <p>{{ tl('Fixed: the date was parsed in the wrong time zone.') }}</p>
      <div class="te-actions"><span class="te-btn">{{ tl('Send') }}</span><span class="te-badge">{{ tl('Done') }}</span></div>
    </div>
    <p v-if="issues.length" class="te-check warn" role="status" data-testid="theme-contrast">
      <UIcon name="i-lucide-triangle-alert" /> {{ tl('Below WCAG AA:') }} {{ issues.join(', ') }}
    </p>
    <p v-else class="te-check" role="status" data-testid="theme-contrast"><UIcon name="i-lucide-check" /> {{ tl('Contrast meets WCAG AA') }}</p>
  </div>
</template>

<style scoped>
.te-preview { display: grid; gap: 8px; padding: 12px; background: var(--bg); color: var(--text); border: 1px solid var(--line); }
.te-row { display: flex; align-items: center; gap: 8px; padding: 8px; background: var(--surface); border: 1px solid var(--line-soft); }
.te-row small { margin-left: auto; color: var(--muted); }
.te-sq { width: 7px; height: 7px; flex: none; }
.te-sq.working { background: var(--working); }
.te-sq.blocked { background: var(--blocked); }
.te-preview p { margin: 0; }
.te-user { justify-self: end; padding: 6px 10px; background: var(--surface-2); }
.te-actions { display: flex; align-items: center; gap: 8px; }
.te-btn { padding: 8px 14px; background: var(--accent); color: var(--on-accent); font-weight: 600; }
.te-badge { padding: 2px 6px; border: 1px solid var(--done); color: var(--done); font: 500 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .12em; }
.te-check { margin: 8px 0 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.te-check.warn { color: var(--ochre); }
</style>
