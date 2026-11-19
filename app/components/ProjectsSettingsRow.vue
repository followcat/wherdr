<script setup lang="ts">
// A compact row of Settings › Projects (ProjectsSettings): the key badge in its
// color, the name, Public, the machine and "1 to review" on one line, the
// folder small under it; long ones end with an ellipsis. A tap is the parent's
// click (it opens the project's sheet).
import type { Project } from '#shared/pm/project'
import { shownKey } from '#shared/pm/projectKey'

defineProps<{ project: Project, machine: string, review?: boolean }>()
</script>

<template>
  <button type="button" class="pm-item">
    <span class="pm-id">
      <span class="pm-line">
        <ProjectBadge :text="shownKey(project)" :color="project.color" />
        <b class="pm-name">{{ project.name }}</b>
        <span v-if="project.visibility?.value === 'public'" class="pm-public" data-testid="pm-public">{{ tl('Public', 'Public') }}</span>
        <small class="mono-label pm-machine">{{ machine }}</small>
        <small v-if="review" class="mono-label pm-review" data-testid="pm-review"><span class="card-state blocked" aria-hidden="true"><i /></span>{{ tl('1 to review') }}</small>
      </span>
      <small class="pm-path">{{ ltr(shortPath(project.path)) }}</small>
    </span>
    <UIcon name="i-lucide-chevron-right" class="pm-chevron" />
  </button>
</template>

<style scoped>
.pm-item { display: flex; width: 100%; min-width: 0; min-height: 44px; align-items: center; gap: 12px; padding: 7px 16px; text-align: left; }
.pm-item:active { background: var(--surface-2); }
.pm-id { display: grid; flex: 1; gap: 1px; min-width: 0; }
.pm-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pm-name, .pm-machine, .pm-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-name { flex: 0 1 auto; }
/* The machine gives way first, then the name. */
.pm-machine { flex: 0 1000 auto; color: var(--muted); }
.pm-public { flex: none; padding: 2px 6px; border: 1px solid var(--blocked); color: var(--blocked); font: 600 11px/1 var(--font-mono, 'JetBrains Mono', monospace); letter-spacing: .08em; text-transform: uppercase; }
.pm-review { display: flex; flex: none; align-items: center; gap: 6px; color: var(--blocked); white-space: nowrap; }
.pm-path { color: var(--muted); font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12px; }
.pm-chevron { flex: none; color: var(--muted); }
</style>
