<script setup lang="ts">
// Getting started with project management: four steps, each marked done or
// not, with a button that goes there. Shown on the board while nothing is set
// up (or always with `always`, from Settings › Projects).
import type { PmOverview } from '#shared/pm/project'
import { guideNeeded, guideProject, guideSteps, type GuideStepId } from '#shared/pm/guide'

const props = defineProps<{ always?: boolean }>()
const data = ref<PmOverview | null>(null)
const busy = ref(false)
const error = ref('')

async function load() {
  // Both before showing, so the last step does not flash from to do to done.
  try { const [o] = await Promise.all([api<PmOverview>('/api/pm/overview'), loadCoordinators()]); data.value = o }
  catch (e) { error.value = (e as Error).message }
}
onMounted(load)

const steps = computed(() => guideSteps(data.value, coordinators.value))
const shown = computed(() => !!data.value && (props.always || guideNeeded(data.value)))
const project = computed(() => guideProject(data.value))
const SETTINGS = '/settings?section=projects'

const TEXT: Record<GuideStepId, { title: [string, string], body: [string, string], action: [string, string] }> = {
  enable: {
    title: ['Turn on project management', 'Active la gestion de projet'],
    body: ['In Settings › Projects. Off, nothing is changed.', 'Dans Réglages › Projets. Coupée, rien n’est modifié.'],
    action: ['Open Projects', 'Ouvrir Projets'],
  },
  template: {
    title: ['Create or pick a template', 'Crée ou choisis un modèle'],
    body: ['A template is the list of steps a task goes through, and who does each one. Start from the example “vibe”.', 'Un modèle est la liste des étapes d’une tâche, et qui fait chacune. Pars de l’exemple « vibe ».'],
    action: ['Open Templates', 'Ouvrir Modèles'],
  },
  projects: {
    title: ['Give each project a template', 'Donne un modèle à chaque projet'],
    body: ['Add a project, or pick a template for each one: imported projects have none, and their tasks cannot start without it.', 'Ajoute un projet, ou choisis un modèle pour chacun : les projets importés n’en ont pas, et leurs tâches ne peuvent pas démarrer sans.'],
    action: ['Open Projects', 'Ouvrir Projets'],
  },
  coordinator: {
    title: ['Start the project coordinator', 'Lance le coordinateur du projet'],
    body: ['The agent you talk to about the project: it adds tasks and follows them on the board.', 'L’agent à qui tu parles du projet : il ajoute les tâches et les suit sur le tableau.'],
    action: ['Start', 'Lancer'],
  },
}

// The coordinator's kept conversation if it runs, else a new one.
async function startCoordinator() {
  const key = project.value
  if (!key || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const c = coordinators.value.find(x => x.project === key)
    const p = (c && coordinatorPane(c)) || await launchCoordinator(key)
    if (p) await navigateTo(panePath(p.id))
  }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
const ready = (id: GuideStepId) => id !== 'coordinator' || !!project.value
</script>

<template>
  <section v-if="shown" class="pm-guide" data-testid="pm-guide" :aria-label="tl('Getting started', 'Pour commencer')">
    <h2 class="mono-label">{{ tl('Getting started', 'Pour commencer') }}</h2>
    <ol>
      <li v-for="(s, i) in steps" :key="s.id" class="pm-guide-step" :class="{ done: s.done }" data-testid="pm-guide-step" :data-step="s.id" :data-done="s.done">
        <span class="card-state" :class="s.done ? 'done' : 'inactive'" role="img" :aria-label="s.done ? tl('Done', 'Fait') : tl('To do', 'À faire')"><i /></span>
        <span class="pm-guide-text">
          <b>{{ i + 1 }}. {{ tl(...TEXT[s.id].title) }}</b>
          <small>{{ tl(...TEXT[s.id].body) }}</small>
        </span>
        <UButton
          v-if="s.id === 'coordinator'" :color="s.done ? 'neutral' : 'primary'" :variant="s.done ? 'outline' : 'solid'" size="lg"
          :disabled="!ready(s.id)" :loading="busy" data-testid="pm-guide-action" @click="startCoordinator"
        >
          {{ s.done ? tl('Open', 'Ouvrir') : tl(...TEXT[s.id].action) }}
        </UButton>
        <UButton v-else :to="SETTINGS" :color="s.done ? 'neutral' : 'primary'" :variant="s.done ? 'outline' : 'solid'" size="lg" data-testid="pm-guide-action">
          {{ tl(...TEXT[s.id].action) }}
        </UButton>
      </li>
    </ol>
    <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
  </section>
</template>

<style scoped>
/* flex: none: the board's lanes take the rest of the height. */
.pm-guide { flex: none; border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.pm-guide h2 { margin: 0; }
.pm-guide ol { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); background: var(--surface); }
.pm-guide-step { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px; border-bottom: 1px solid var(--line); }
.pm-guide-step:last-child { border-bottom: 0; }
.pm-guide-step .card-state { align-self: start; margin-top: 5px; }
.pm-guide-step .card-state.inactive i { background: transparent; box-shadow: inset 0 0 0 1.5px currentColor; }
.pm-guide-text { display: grid; gap: 2px; min-width: 0; }
.pm-guide-text small { color: var(--muted); font-size: 13px; line-height: 1.4; }
.pm-guide-step.done .pm-guide-text b { color: var(--text-2); }
.pm-guide-step :deep(button), .pm-guide-step :deep(a) { min-height: 44px; }
@media (max-width: 520px) {
  .pm-guide-step { grid-template-columns: 10px minmax(0, 1fr); }
  .pm-guide-step > :last-child { grid-column: 2; justify-self: start; }
}
@media (min-width: 900px) {
  .pm-guide > * { max-width: 760px; }
}
</style>
