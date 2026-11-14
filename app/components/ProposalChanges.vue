<script setup lang="ts">
// A proposed workflow change as a person reads it (shared/pm/workflowChanges):
// per task type, its step list with the steps added, removed or changed, and
// each changed field before → after; instructions as a line diff.
import type { FieldChange, WorkflowChanges } from '#shared/pm/workflowChanges'
import { lineDiff } from '#shared/pm/coordinator'

defineProps<{ changes: WorkflowChanges }>()
const KIND = { added: 'new', removed: 'removed', changed: 'changed', moved: 'moved', same: '' } as const
const textDiff = (f: FieldChange) => diffLines(lineDiff((f.before ?? '').split('\n'), (f.after ?? '').split('\n'), true).join('\n'))
</script>

<template>
  <div class="wf-changes" data-testid="proposal-changes">
    <template v-for="(group, gi) in [{ title: tl('All task types'), kind: 'changed' as const, fields: changes.all, steps: [] }, ...changes.types.map(t => ({ ...t, title: t.type }))]" :key="gi">
      <section v-if="group.fields.length || group.steps.length || group.kind !== 'changed'" class="wf-type">
        <h4 class="mono-label">{{ group.title }}<span v-if="group.kind !== 'changed'" class="wf-kind" :class="group.kind"> · {{ tl(KIND[group.kind]) }}</span></h4>
        <ul v-if="group.fields.length" class="wf-fields">
          <li v-for="f in group.fields" :key="f.field">
            <span class="wf-field">{{ f.field }}</span>
            <pre v-if="f.field === 'instructions'" class="wf-text"><span v-for="(d, i) in textDiff(f)" :key="i" :class="d.k">{{ d.l }}
</span></pre>
            <span v-else><del v-if="f.before">{{ f.before }}</del><span v-else class="muted">{{ tl('none') }}</span> → <ins v-if="f.after">{{ f.after }}</ins><span v-else class="muted">{{ tl('none') }}</span></span>
          </li>
        </ul>
        <ol v-if="group.steps.length" class="wf-steps">
          <li v-for="s in group.steps" :key="s.id" :class="s.kind" :data-kind="s.kind">
            <div class="wf-step-head">
              <span class="wf-step-id">{{ s.id }}</span>
              <span class="muted">{{ s.holder }}<template v-if="s.ends"> · {{ s.ends }}</template></span>
              <span v-if="s.kind !== 'same'" class="wf-kind mono-label" :class="s.kind">{{ tl(KIND[s.kind]) }}</span>
            </div>
            <ul v-if="s.fields.length" class="wf-fields">
              <li v-for="f in s.fields" :key="f.field">
                <span class="wf-field">{{ f.field }}</span>
                <pre v-if="f.field === 'instructions'" class="wf-text"><span v-for="(d, i) in textDiff(f)" :key="i" :class="d.k">{{ d.l }}
</span></pre>
                <span v-else><del v-if="f.before">{{ f.before }}</del><span v-else class="muted">{{ tl('none') }}</span> → <ins v-if="f.after">{{ f.after }}</ins><span v-else class="muted">{{ tl('none') }}</span></span>
              </li>
            </ul>
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>

<style scoped>
.wf-changes { display: grid; gap: 14px; max-height: 55vh; overflow: auto; }
.wf-type { display: grid; gap: 6px; }
.wf-type h4 { margin: 0; color: var(--text-2); }
.wf-steps, .wf-fields { margin: 0; padding: 0; list-style: none; display: grid; }
.wf-steps { border: 1px solid var(--line); }
.wf-steps > li { padding: 6px 8px; border-left: 3px solid transparent; }
.wf-steps > li + li { border-top: 1px solid var(--line-soft); }
.wf-steps > li.added { border-left-color: var(--green); }
.wf-steps > li.removed { border-left-color: var(--rose); }
.wf-steps > li.removed .wf-step-id { text-decoration: line-through; color: var(--muted); }
.wf-steps > li.changed, .wf-steps > li.moved { border-left-color: var(--accent); }
.wf-steps > li.same { color: var(--muted); }
.wf-step-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.wf-step-id { font: 13px/1.4 var(--font-mono); }
.wf-kind.added { color: var(--green); }
.wf-kind.removed { color: var(--rose); }
.wf-kind.changed, .wf-kind.moved { color: var(--accent); }
.wf-fields { gap: 4px; padding-top: 4px; font-size: 13px; overflow-wrap: anywhere; }
.wf-field { font: 12px/1.4 var(--font-mono); color: var(--muted); margin-right: 6px; }
del { color: var(--rose); }
ins { color: var(--green); text-decoration: none; }
.wf-text { margin: 4px 0 0; padding: 6px; border: 1px solid var(--line); background: var(--bg); font: 12px/1.5 var(--font-mono); white-space: pre-wrap; }
.wf-text .add { color: var(--green); }
.wf-text .del { color: var(--rose); }
</style>
