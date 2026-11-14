<script setup lang="ts">
// A task's sheet. A task waiting for the user opens on To do (TaskTodo): what
// it needs from them and its buttons. Otherwise: its Plan (the steps, the current one, what its holder was
// told, the proofs and rounds), its links, Open the agent (AgentButton: whatever the step, disabled once it ended), and
// the step's button when it waits for the user ("Merged"; busy while it runs, a
// refused action said in plain words under it), Start for a task to do (or
// the tasks it waits for; a refusal said under it), Stop (with its
// reason, confirmed here), how a stopped task goes on, Check on GitHub for a
// task at its merge step or archived with a PR (what it found said under the
// buttons, with the PR and, for a PR closed unmerged, Archive), and Delete for
// a task never started (confirmed), Unarchive for an archived one. Those stay at the top; below, tabs (the app's
// segmented style) for the rest, in the sheet's one scroll: Description (the
// text in Markdown, the chat's safe renderer, no raw HTML; tags and links, the PR apart), Plan (each step with its
// screenshots), Comments (the worker's and the reviewer's reports, in order)
// and History (the whole log as one timeline, the hand-offs as entries; TaskHistory).
// The PR's badge sits on the branch line; scrolled out of sight, it shows in the
// sheet's header, so the PR is always one tap away.
import { branchLine, canStart, canStop, cardStatus, linkLabel, mergeWaits, prLink, statusText, type Card } from '#shared/pm/board'
import { canCheckGithub, type GhCheck } from '#shared/pm/ghCheck'
import type { Pane } from '#shared/types'
import { reviewSwitch } from '#shared/pm/run'
import { shotMode } from '#shared/pm/shots'
import { timesText } from '#shared/pm/times'
import { nextRecheck } from '#shared/pm/steps'

// stopping: opened from the card menu's Stop, the confirmation shown.
// reporting: opened from its Report a problem, the form shown (TaskReport).
// projectBase: the project's working branch, where a task goes by default.
// checking: opened from the card menu's Check on GitHub, the check run at once.
const props = defineProps<{ card: Card, pane?: Pane, stopping?: boolean, reporting?: boolean, checking?: boolean, waitsFor?: string[], projectBase?: string }>()
const emit = defineEmits<{ closed: [], changed: [] }>()
const open = ref(true)
const { busy, error, pressing, refused, run, press, start, resume, decide, sendBack, restartReview, startWorker, askCoordinator } = useTaskActions(() => props.card, () => emit('changed'))

const at = computed(() => (props.card.state?.started ? props.card.state.at : -1))
const done = computed(() => !!props.card.state?.done)
// Where a step's commit links to: its own link proof first, then the other steps', then the task's links
// (a task-level link may point at another repository).
const proofLinks = (id: string) => {
  const given = props.card.state?.proofs ?? {}
  const urls = [given[id]?.link, ...props.card.plan.map(p => given[p.id]?.link), ...props.card.links.map(l => l.url)]
  return urls.filter((u): u is string => !!u).map(url => ({ label: '', url }))
}
const proofs = (id: string) => Object.entries(props.card.state?.proofs[id] ?? {}).filter((e): e is [string, string] => !!e[1])
const rounds = (id: string) => props.card.state?.rounds[id] ?? 0
// The steps that have screenshots, to look at before the push, the PR or the merge.
const shots = (id: string) => props.card.state?.shots?.[id] ?? []
// The sets a rework after the review replaced.
const earlier = (id: string) => props.card.state?.earlierShots?.[id] ?? []
// The fallback took the last review (the review agent out of quota): said on the review step it holds now or held last.
const switched = computed(() => reviewSwitch(props.card.log))
const switchAt = computed(() => props.card.plan.findLastIndex((s, i) => s.holder === 'reviewer' && (done.value || i <= at.value)))
// Where its PR and merge stand (the card's line), with the full time and the approval's date.
const status = computed(() => { const s = cardStatus(props.card); return s && { ...s, text: statusText(s, fmtDateTime, true) } })

// Which branch merges into which, once it has a branch.
const branch = computed(() => branchLine(props.card, props.projectBase))
// The task's PR (the github.pr step's or a link proof's), a badge on that line,
// not repeated with the other links under the description.
const pr = computed(() => prLink(props.card))
const otherLinks = computed(() => props.card.links.filter(l => l.url !== pr.value?.url))
// The branch line scrolled out of the sheet: the badge moves to its header.
const branchRow = ref<HTMLElement>()
const prHidden = ref(false)
let io: IntersectionObserver | undefined
watch(branchRow, (el) => {
  io?.disconnect()
  prHidden.value = false
  if (!el || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver(([e]) => { prHidden.value = !e?.isIntersecting })
  io.observe(el)
})
onBeforeUnmount(() => io?.disconnect())

// Time per step, the waits for the user apart, review rounds and CI fixes, in one line.
const times = computed(() => (props.card.times ? timesText(props.card.times) : ''))
// A step the coordinator rechecks: when its next recheck is due.
const recheck = computed(() => { const n = nextRecheck(props.card.state); return n === 'user' ? tl('Next recheck: when you write to the coordinator or act on the task') : n ? `${tl('Next recheck')} ${n - Date.now() < 43_200_000 ? fmtTime(n) : fmtDateTime(n)}` : '' })

const todo = computed(() => taskTodo(props.card))
const descHtml = computed(() => (props.card.description ? md(props.card.description, { plain: true }) : ''))
function onDescClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest?.('.code-copy') as HTMLElement | null
  const text = btn?.closest('.code-block')?.querySelector('pre')?.textContent
  if (btn && text != null) copyCodeBlock(btn, text)
}
type Tab = 'todo' | 'description' | 'plan' | 'comments' | 'history'
const TAB_LABEL: Record<Tab, [string, string?]> = { todo: ['To do', 'À faire'], description: ['Description', 'Description'], plan: ['Plan', 'Plan'], comments: ['Comments'], history: ['History'] }
const tabs = computed<Tab[]>(() => [
  ...(todo.value ? ['todo' as const] : []),
  ...(props.card.description || props.card.specNotes?.length || props.card.tags.length || otherLinks.value.length ? ['description' as const] : []),
  'plan',
  ...(props.card.log.length ? ['comments' as const, 'history' as const] : []),
])
const picked = ref<Tab>()
// The tab picked while it is still there (the task read again), else the first.
const tab = computed(() => (picked.value && tabs.value.includes(picked.value) ? picked.value : tabs.value[0]!))

const confirmStop = ref(!!props.stopping)
const why = ref('')
const stop = () => run(async () => { await stopTaskApi(props.card.id, why.value); confirmStop.value = false })
// A problem reported to the coordinator: open on the card until it acts or the user withdraws it.
const reportOpen = ref(!!props.reporting)
// An action step that failed (a merge refused): the user runs it again.
// Not an approved merge on its way: a refusal the queue tries again is not the user's (mergeWaits).
const failedAction = computed(() => { const s = props.card.state; return !props.card.stopped && !!s && !s.acting && s.yourTurn?.reason === 'action' && !!props.card.plan[s.at]?.action && mergeWaits(props.card) === undefined })
const canReport = computed(() => !!props.card.yourTurn && !props.card.state?.done && !props.card.report)
const report = (r: { text: string, shots: string[], block: boolean }) => run(async () => { await api('/api/pm/report', { id: props.card.id, ...r }); reportOpen.value = false })
const withdraw = () => run(() => api('/api/pm/report', { id: props.card.id, withdraw: true }))
const check = ref<GhCheck>()
const checkGithub = () => run(async () => { check.value = (await api<{ check: GhCheck }>('/api/pm/task-check', { id: props.card.id })).check })
const archiveClosed = () => run(async () => { const yes = await archiveClosedApi(props.card.id, !!props.card.stopped); if (yes) check.value = undefined; return yes })
onMounted(() => { if (props.checking) checkGithub() })
// Archived (off the board, done for its project's delay): back in Done.
const unarchive = () => run(() => api('/api/pm/task-unarchive', { id: props.card.id }))
// Removed: the sheet closes, the board reloads without it.
const remove = () => run(async () => { const yes = await removeTaskApi(props.card.id); if (yes) open.value = false; return yes })
</script>

<template>
  <AppSheet v-model:open="open" :title="card.title" tall clamp hide-close @closed="emit('closed')">
    <template #lead>
      <span class="task-sheet-lead">
        <ProjectBadge :text="card.shown" :color="card.color" copy />
        <a v-if="pr && prHidden" :href="pr.url" target="_blank" rel="noopener" class="board-chip task-pr" data-testid="task-pr-head">{{ linkLabel(pr) }} <UIcon name="i-lucide-arrow-up-right" aria-hidden="true" /></a>
      </span>
    </template>
    <div class="task-sheet" data-testid="task-sheet">
      <div class="task-sheet-top">
        <p v-if="card.step" class="mono-label">{{ card.step }}</p>
        <p v-if="status" class="task-status" :class="status.tone" data-testid="task-status">{{ status.text }}</p>
        <div v-if="branch || pr" ref="branchRow" class="task-branch-row" data-testid="task-branch-row">
          <BranchLine v-if="branch" :line="branch" />
          <a v-if="pr" :href="pr.url" target="_blank" rel="noopener" class="board-chip task-pr" data-testid="task-pr">{{ linkLabel(pr) }} <UIcon name="i-lucide-arrow-up-right" aria-hidden="true" /></a>
        </div>
        <p v-if="times" class="task-times" data-testid="task-times">{{ times }}</p>
        <p v-if="recheck" class="task-times" data-testid="task-recheck">{{ recheck }}</p>
        <p v-if="card.archived" class="muted" data-testid="task-archived">{{ tl('Archived') }} {{ fmtWhen(new Date(card.archived).toISOString()) }}</p>
        <div class="task-sheet-actions">
          <UButton v-if="!todo && canStart(card) && !waitsFor?.length" color="primary" size="xl" icon="i-lucide-play" :loading="busy" data-testid="task-start" @click="start">{{ card.sameFiles ? tl('Start anyway') : tl('Start', 'Lancer') }}</UButton>
          <UButton v-if="failedAction" color="primary" size="xl" icon="i-lucide-rotate-ccw" :loading="busy" data-testid="task-retry" @click="press">{{ tl('Try again', 'Réessayer') }}</UButton>
          <UButton v-if="canReport && !reportOpen" color="neutral" variant="outline" size="xl" icon="i-lucide-flag" data-testid="task-report-start" @click="reportOpen = true">{{ tl('Report a problem') }}</UButton>
          <AgentButton v-if="!card.archived" :card="card" :primary="todo === 'ask'" />
          <UButton v-if="canStop(card) && !confirmStop" color="error" variant="outline" size="xl" icon="i-lucide-square" data-testid="task-stop" @click="confirmStop = true">{{ tl('Stop', 'Arrêter') }}</UButton>
          <UButton v-if="canCheckGithub(card)" color="neutral" variant="outline" size="xl" icon="i-lucide-refresh-cw" :loading="busy" data-testid="task-check" @click="checkGithub">{{ tl('Check on GitHub') }}</UButton>
          <UButton v-if="card.archived" color="neutral" variant="outline" size="xl" icon="i-lucide-archive-restore" :loading="busy" data-testid="task-unarchive" @click="unarchive">{{ tl('Unarchive') }}</UButton>
          <UButton v-if="card.removable" color="error" variant="outline" size="xl" icon="i-lucide-trash-2" :loading="busy" data-testid="task-remove" @click="remove">{{ tl('Delete…', 'Supprimer…') }}</UButton>
        </div>
        <p v-if="card.mergeAfter?.length && !card.state?.done" class="muted" data-testid="task-merge-after">{{ tl(`Merges once ${card.mergeAfter.join(', ')} ${card.mergeAfter.length > 1 ? 'are' : 'is'} done.`) }}</p>
        <p v-if="canStart(card) && waitsFor?.length" class="muted" data-testid="task-waits">{{ tl(`Starts once ${waitsFor.join(', ')} ${waitsFor.length > 1 ? 'are' : 'is'} done.`, `Démarre une fois ${waitsFor.join(', ')} terminée${waitsFor.length > 1 ? 's' : ''}.`) }}</p>
        <form v-if="canStop(card) && confirmStop" class="task-stop-confirm" data-testid="task-stop-confirm" @submit.prevent="stop">
          <p>{{ tl('Stop this task? Its agent ends; the worktree, branch and work stay, and nothing is merged.', 'Arrêter cette tâche ? Son agent s’arrête ; le worktree, la branche et le travail restent, rien n’est fusionné.') }}</p>
          <UInput v-model="why" size="xl" maxlength="300" :placeholder="tl('Why (optional)', 'Pourquoi (facultatif)')" data-testid="task-stop-why" />
          <div class="task-sheet-actions">
            <UButton type="submit" color="error" size="xl" :loading="busy" data-testid="task-stop-yes">{{ tl('Stop the task', 'Arrêter la tâche') }}</UButton>
            <UButton color="neutral" variant="outline" size="xl" :disabled="busy" @click="confirmStop = false">{{ t('Cancel') }}</UButton>
          </div>
        </form>
        <TaskReport v-if="canReport && reportOpen" :card="card" :busy="busy" @send="report" @cancel="reportOpen = false" />
        <div v-if="card.report" class="task-report-open" data-testid="task-report-open">
          <p><b>{{ tl('Problem reported') }} {{ fmtTime(card.report.at) }}</b><template v-if="card.report.block"> · {{ tl('merge blocked') }}</template></p>
          <p class="task-desc">{{ card.report.text }}</p>
          <UButton color="neutral" variant="outline" size="xl" :loading="busy" data-testid="task-report-withdraw" @click="withdraw">{{ tl('Withdraw') }}</UButton>
        </div>
        <div v-if="check" class="task-check" role="status" :data-outcome="check.outcome" data-testid="task-check-result">
          <p class="task-status" :class="{ merged: 'ok', open: 'wait', closed: 'bad' }[check.outcome]">{{ check.text }}</p>
          <div class="task-sheet-actions">
            <UButton color="neutral" variant="ghost" size="xl" icon="i-lucide-square-arrow-out-up-right" :to="check.url" target="_blank">{{ tl('Open the PR') }}</UButton>
            <UButton v-if="check.archive" color="error" variant="outline" size="xl" icon="i-lucide-archive" :loading="busy" data-testid="task-check-archive" @click="archiveClosed">{{ tl('Archive…') }}</UButton>
          </div>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
      </div>

      <div class="segmented task-tabs" role="tablist" :style="{ '--segment-count': tabs.length }">
        <button v-for="k in tabs" :id="`task-tab-${k}`" :key="k" type="button" role="tab" :class="{ on: tab === k }" :aria-selected="tab === k" :aria-controls="tab === k ? 'task-panel' : undefined" :data-tab="k" @click="picked = k">
          <span>{{ tl(...TAB_LABEL[k]) }}</span>
        </button>
      </div>

      <div id="task-panel" class="task-panel" role="tabpanel" :aria-labelledby="`task-tab-${tab}`" data-testid="task-panel">
        <TaskTodo v-if="tab === 'todo' && todo" :card="card" :kind="todo" :pane="pane" :busy="busy" :pressing="pressing" :refused="refused" :waits-for="waitsFor"
          @press="press" @start="start" @resume="resume" @decide="decide" @back="sendBack" @review="restartReview" @worker="startWorker" @ask="askCoordinator" @comments="picked = 'comments'" />
        <template v-else-if="tab === 'description'">
          <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitized by DOMPurify (utils/markdown.ts) -->
          <div v-if="descHtml" class="md-body task-md" data-testid="task-description" @click="onDescClick" v-html="descHtml" />
          <section v-if="card.specNotes?.length" class="task-spec-notes" data-testid="task-spec-notes">
            <span class="mono-label">{{ tl('Spec changes · the latest overrides the description') }}</span>
            <p v-for="n in card.specNotes" :key="n.at" class="task-spec-note"><span class="mono-label">{{ fmtDateTime(n.at) }}</span> {{ n.text }}</p>
          </section>
          <div v-if="card.tags.length || otherLinks.length" class="board-tags" data-testid="task-links">
            <span v-for="tag in card.tags" :key="tag" class="board-chip">{{ tag }}</span>
            <a v-for="l in otherLinks" :key="l.url" :href="l.url" target="_blank" rel="noopener" class="board-chip">{{ linkLabel(l) }}</a>
          </div>
        </template>

        <ol v-else-if="tab === 'plan'" class="task-plan" data-testid="task-plan">
          <li v-for="(s, i) in card.plan" :key="s.id" :class="{ now: i === at && !done, past: i < at || done }" :aria-current="i === at && !done ? 'step' : undefined">
            <span class="mono-label">{{ s.id }} · {{ s.column || s.id }}<template v-if="s.holder && s.holder !== 'none'"> · {{ s.holder }}</template><template v-if="rounds(s.id)"> · {{ tl(`${rounds(s.id)} send-backs`, `${rounds(s.id)} renvois`) }}</template></span>
            <details v-if="s.text && s.holder && s.holder !== 'none'">
              <summary>{{ tl('Instructions', 'Consignes') }}</summary>
              <p class="task-desc">{{ s.text }}</p>
            </details>
            <small v-if="switched && i === switchAt" class="muted" data-testid="review-switch">{{ switched }}</small>
            <TaskProofs :proofs="proofs(s.id)" :links="proofLinks(s.id)" />
            <TaskShots v-if="shots(s.id).length" :task="card.id" :shots="shots(s.id)" :mode="shotMode(s)" />
            <details v-if="earlier(s.id).length" data-testid="shots-earlier">
              <summary>{{ tl('Earlier screenshots') }}</summary>
              <TaskShots :task="card.id" :shots="earlier(s.id)" :mode="shotMode(s)" />
            </details>
          </li>
        </ol>

        <TaskHistory v-else :card="card" :comments="tab === 'comments'" />
      </div>
    </div>
  </AppSheet>
</template>

<style scoped>
/* One scroll, the sheet's body (a flex column, main.css): the sheet fills it
   and grows with its tab, whose panel takes its natural height. */
.task-sheet { display: flex; flex-direction: column; gap: 12px; flex: 1 0 auto; padding: 0 16px; }
.task-sheet-top { display: flex; flex-direction: column; gap: 10px; flex: none; }
.task-sheet p { margin: 0; }
.task-tabs { flex: none; }
.task-status { font-size: 13px; overflow-wrap: anywhere; color: var(--muted); }
.task-status.wait { color: var(--working); }
.task-status.bad { color: var(--danger); }
.task-status.ok { color: var(--done); }
.task-check { display: grid; gap: 4px; }
/* The branch line, then the PR's badge; on a narrow screen the badge wraps to
   the next line and the branch names ellipsize, never a sideways scroll. */
.task-branch-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; }
.task-branch-row > .branch-line { flex: 0 1 auto; }
.task-pr { display: inline-flex; align-items: center; gap: 4px; flex: none; min-height: 24px; white-space: nowrap; }
.task-pr .iconify { width: 12px; height: 12px; }
.task-sheet-lead { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.task-times { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.task-panel { display: flex; flex-direction: column; gap: 10px; min-width: 0; flex: 1 0 auto; }
.task-desc { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2); }
/* Headings shown small: a description is not a document. */
.task-md { flex: none; overflow-wrap: anywhere; color: var(--text-2); }
.task-md :deep(:is(h1, h2, h3, h4, h5, h6)) { font-size: 15px; margin: 1em 0 .4em; }
.task-sheet .task-md :deep(p) { margin: 0 0 .75em; }
.task-spec-notes { display: grid; gap: 6px; }
.task-spec-note { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; color: var(--text-2); }
.task-sheet-actions { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; }
.task-sheet-actions:empty { display: none; }
/* On the phone a row's buttons share its width: a wrapped row is full too
   (Stop under Try again and Report a problem spans the line, not one stray button). */
@media (max-width: 699px) {
  .task-sheet-actions > * { flex: 1 1 auto; justify-content: center; }
}
.task-report-open { display: grid; gap: 6px; justify-items: start; padding: 10px 12px; border: 1px solid var(--working); }
.task-stop-confirm { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid var(--danger); }
.task-plan { list-style: none; margin: 0; padding: 0; }
.task-plan li { display: flex; flex-direction: column; gap: 4px; padding: 8px 0 8px 12px; border-bottom: 1px solid var(--line-soft); border-left: 2px solid transparent; }
.task-plan li.past { color: var(--muted); }
.task-plan li.now { border-left-color: var(--accent); }
.task-plan summary { cursor: pointer; min-height: 32px; display: flex; align-items: center; }
</style>
