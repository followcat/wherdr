<script setup lang="ts">
// Alfred, wherdr's assistant: the first row of the agent list, always there
// (projects on or off). Not started: a greyed row; the first time, a sheet
// asks for its program (the offered agents of Settings › Agents installed on
// wherdr's machine, in the user's order; no model: the user changes it inside Alfred), remembered after. Its menu
// (right click, or long press on a touch screen) restarts it with another
// program: the same Alfred (home folder, identity, memory), the old session
// stopped. As a banner (the board's All projects): the same one tap, no menu.
import { MAIN } from '#shared/pm/coordinator'
import type { AlfredProgram } from '#shared/pm/alfred'

const props = defineProps<{ banner?: boolean }>()
const busy = ref(false)
const error = ref('')
const sheet = ref(false)
const pick = ref('')

const name = computed(() => alfred.value?.name || 'Alfred')
const current = computed(() => (alfredPane.value ? alfred.value?.ran : undefined) ?? alfred.value?.program)
// The offered agents installed on wherdr's own machine that can carry Alfred.
const choices = computed(() => offerCoordinators(appConfig.value.machines?.find(m => m.local)?.kinds ?? appConfig.value.kinds))
// Its conversation is the one open: the same selected style as agent cards.
const selected = computed(() => !props.banner && !!alfredPane.value && alfredPane.value.id === curPane.value)
const sub = computed(() => {
  if (busy.value) return tl('Starting…', 'Lancement…')
  if (alfredPane.value) return `${current.value ? `${kindLabel(current.value)} · ` : ''}${statusLabel(alfredPane.value)}`
  return current.value ? tl(`not started · ${kindLabel(current.value)}`, `pas lancé · ${kindLabel(current.value)}`) : tl('not started', 'pas lancé')
})
const menu = (): MenuItem[] => (props.banner ? [] : [{
  label: alfredPane.value ? tl('Restart with…', 'Relancer avec…') : tl('Start with…', 'Lancer avec…'),
  icon: 'i-lucide-refresh-cw', run: choose,
}])
const rowMenu = useRowMenu()

function choose() {
  pick.value = current.value && choices.value.includes(current.value) ? current.value : choices.value[0] ?? ''
  sheet.value = true
}
async function start(program: AlfredProgram) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  sheet.value = false
  try {
    const p = await launchCoordinator(MAIN, { program })
    await loadAlfred()
    if (p) await navigateTo(panePath(p.id))
  }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
// One tap: its conversation, else a start with its agent (chosen first, the first time).
async function open() {
  if (rowMenu.swallowClick()) return
  if (alfredPane.value) return navigateTo(panePath(alfredPane.value.id))
  // Its program unchecked in Settings since: pick another.
  if (!alfred.value?.program || !choices.value.includes(alfred.value.program)) return choose()
  await start(alfred.value.program)
}
const picked = () => choices.value.find(p => p === pick.value)

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { loadAlfred(); timer = setInterval(loadAlfred, 30_000) })
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <UContextMenu :disabled="sheetMenus || banner" :items="rowMenu.dropdown(menu)" :press-open-delay="700" :ui="{ content: 'hw-dropdown' }" @update:open="rowMenu.opened">
  <div class="alfred" :class="{ on: !!alfredPane, banner, sel: selected }" data-testid="alfred" v-on="rowMenu.on(menu, name)">
    <button type="button" class="alfred-open" :disabled="busy" data-testid="alfred-open" :aria-current="selected ? 'page' : undefined" @click="open">
      <i class="alfred-dot" aria-hidden="true" />
      <span class="alfred-text"><b data-testid="alfred-name">{{ name }}</b><small data-testid="alfred-sub">{{ banner ? `${tl('All projects', 'Tous les projets')} · ${sub}` : sub }}</small></span>
      <UIcon v-if="alfredPane" name="i-lucide-chevron-right" class="alfred-go" />
      <span v-else-if="!busy" class="alfred-start">{{ tl('Start', 'Lancer') }}</span>
    </button>
  </div>
  </UContextMenu>
  <p v-if="error" class="error alfred-error">{{ error }}</p>

  <AppSheet v-model:open="sheet" :title="alfredPane ? tl(`Restart ${name} with…`, `Relancer ${name} avec…`) : alfred?.program ? tl(`Start ${name} with…`, `Lancer ${name} avec…`) : tl('Your assistant’s agent', 'L’agent de ton assistant')">
    <div class="sheet-form" data-testid="alfred-sheet">
      <p class="alfred-note">
        {{ alfred?.program
          ? tl(`The same ${name} carries on: its home folder, identity and memory stay.${alfredPane ? ' The current session stops.' : ''}`, `${name} reprend où il en était : son dossier, son identité et sa mémoire restent.${alfredPane ? ' La session en cours s’arrête.' : ''}`)
          : tl('Alfred is wherdr’s assistant: it helps you get started and coordinates your projects. Pick the agent it runs on; you can change it later from its menu (right click or long press).', 'Alfred est l’assistant de wherdr : il t’aide à démarrer et coordonne tes projets. Choisis l’agent qui le fait tourner ; tu pourras en changer depuis son menu (clic droit ou appui long).') }}
      </p>
      <label class="field-label">{{ tl('Agent', 'Agent') }}</label>
      <AgentPicker v-if="choices.length" v-model="pick" :programs="choices" class="alfred-agents" />
      <p v-else class="alfred-note" data-testid="alfred-none">{{ tl('No offered agent on this machine can run Alfred: install one (Claude Code, Codex, OMP…) or check it in Settings › Agents.', 'Aucun agent proposé sur cette machine ne peut faire tourner Alfred : installe-en un (Claude Code, Codex, OMP…) ou coche-le dans Réglages › Agents.') }}</p>
      <p v-if="choices.length" class="alfred-hint muted">{{ tl('It runs with the agent’s default model; change the model inside Alfred.', 'Il tourne avec le modèle par défaut de l’agent ; change de modèle dans Alfred.') }}</p>
    </div>
    <template #footer>
      <div class="sheet-form">
        <UButton block size="xl" color="primary" class="hw-cta" icon="i-lucide-play" :disabled="!picked()" data-testid="alfred-start" @click="start(picked()!)">
          {{ alfredPane ? tl('Restart', 'Relancer') : tl('Start', 'Lancer') }}
        </UButton>
      </div>
    </template>
  </AppSheet>
</template>

<style scoped>
.alfred { position: relative; display: flex; align-items: stretch; margin-bottom: 20px; border: 1px solid var(--line); background: var(--surface); }
.alfred::before { content: ''; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 2px; background: transparent; }
.alfred.sel { background: var(--surface-2); }
.alfred.sel::before { background: var(--mauve); }
.alfred.banner { flex: none; margin: 0; border-width: 0 0 1px; }
.alfred.banner .alfred-open { padding: 8px 16px; }
.alfred-open { display: flex; flex: 1; align-items: center; gap: 10px; min-width: 0; min-height: 52px; padding: 8px 12px; color: var(--text); text-align: left; cursor: pointer; }
.alfred-open:hover:not(:disabled) { background: var(--surface-2); }
.alfred-open:disabled { cursor: progress; }
.alfred-open:focus-visible { outline: 1px solid var(--mauve); outline-offset: -1px; }
.alfred-dot { flex: none; width: 8px; height: 8px; background: var(--dim); }
.alfred.on .alfred-dot { background: var(--green); }
.alfred-text { display: grid; flex: 1; min-width: 0; }
.alfred-text b { font: 600 15px/1.3 var(--display); }
.alfred:not(.on) .alfred-text b { color: var(--text-2); }
.alfred-text small { overflow: hidden; color: var(--muted); font: 12px/1.4 var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.alfred-go { flex: none; color: var(--dim); }
.alfred-start { flex: none; color: var(--mauve); font: 500 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
.alfred-error { margin: -14px 0 14px; }
.alfred.banner + .alfred-error { margin: 8px 16px; }
.alfred-note { margin: 0 2px 14px; color: var(--text-2); font-size: 14px; }
.alfred-hint { margin: 8px 2px 0; font-size: 13px; }
</style>
