<script setup lang="ts">
// Whether a member's setting follows its workspace (docs/workspaces.md): "From
// <workspace>" while it does, "Own value · Use <workspace>'s" once changed here,
// the button clearing that override alone. ownWorkflow: the member's agents and
// worktree setup come from its own workflow (the Workflow tab gives the
// workspace's back). Nothing for a project outside a workspace.
import type { Project } from '#shared/pm/project'
import type { SharedField } from '#shared/pm/workspace'

const props = defineProps<{ project: Project, field: SharedField, workspace: string, ownWorkflow?: boolean }>()
const emit = defineEmits<{ followed: [project: Project] }>()
const own = computed(() => (props.project.overrides ?? []).includes(props.field))
const busy = ref(false)
const error = ref('')
async function follow() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { emit('followed', (await api<{ project: Project }>('/api/pm/project-update', { key: props.project.key, follow: props.field })).project) }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <small v-if="project.workspace" class="pm-follow" :class="{ own: own || ownWorkflow }" :data-testid="`pm-follow-${field}`" :data-own="own || ownWorkflow">
    <template v-if="ownWorkflow">{{ tl('Own workflow') }}</template>
    <template v-else-if="own">
      <span>{{ tl('Own value') }} ·</span>
      <button type="button" class="pm-follow-use" :disabled="busy" :data-testid="`pm-follow-use-${field}`" @click="follow">{{ tl(`Use ${workspace}'s`) }}</button>
    </template>
    <template v-else>{{ tl(`From ${workspace}`) }}</template>
    <span v-if="error" class="form-error" role="alert">{{ t(error) }}</span>
  </small>
</template>

<style scoped>
/* A mono label under the setting's name: muted while it follows, in the text
   color once it is the member's own, its button an underlined word whose hit
   area reaches 44 px. */
.pm-follow { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; min-width: 0; color: var(--muted); font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12px; overflow-wrap: anywhere; }
.pm-follow.own { color: var(--text-2); }
.pm-follow-use { position: relative; padding: 0; border: 0; background: none; color: var(--accent); font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.pm-follow-use::after { content: ''; position: absolute; inset: -14px -6px; }
.pm-follow-use:disabled { color: var(--muted); cursor: default; }
.pm-follow-use:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
