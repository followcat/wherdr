<script setup lang="ts">
// New agent (Claude, Codex) or terminal: folder (browser + recent ones),
// conversation resume, first message. With project management on, also a
// project: open or start its coordinator, or add one (NewProjectForm), not in a new tab.
// Several machines: choice of the machine, its folders and recent ones.
// "New tab" (`newTabSpace`): a new terminal labelled for that space, on its
// machine.
// On the phone it opens full screen, Launch pinned at the bottom.
import type { MachineConfig } from '#shared/types'
import type { ProjectDraft } from '#shared/pm/newProject'
import { machineOf } from '#shared/ids'
import { selectedAgentKind, visibleAgentKinds } from '~/utils/agentChoices'

const open = newAgentOpen
const kind = ref<string>('')
const dir = ref<string | null>(null)
const resume = ref(false)
const prompt = ref('')
// Typed as the user wants it (spaces too): the new space's name, or the
// pane's in an existing space. The server derives Herdr's agent id from it.
const name = ref('')
const error = ref<string | null>(null)
const launching = ref(false)
const browsing = ref(false)
const coordinator = ref(false)
const coordProject = ref('')
const coordAgent = ref('')
const draft = ref<ProjectDraft | null>(null)
const canCoordinate = computed(() => !newTabSpace.value && coordinators.value.length > 0)
watch(canCoordinate, (can) => { if (!can && !newProjectOpen.value) coordinator.value = false })

// Settings › Agents: the offered agents of this machine, in the user's order (the first is the default).
const kinds = computed(() => visibleAgentKinds(machineCfg.value?.kinds || appConfig.value.kinds || [], hiddenAgents.value, agentOrder.value))
const shell = computed(() => kind.value === 'shell')
const canResume = computed(() => kind.value === 'claude' || kind.value === 'codex')

// ------------------------------------------------------------ tab to create
const targetWs = computed(() => (newTabSpace.value ? herdrState.value.workspaces.find(w => w.id === newTabSpace.value) : undefined))
// Tab to create: machine imposed.
const fixedMachine = computed(() => newTabSpace.value)
// Folder suggested for the new tab: that of a pane of its space.
const spaceCwd = (ws: string) => herdrState.value.panes.find(p => p.workspace === ws && p.cwd)?.cwd || null
watch(newAgentOpen, (o) => {
  if (!o) { newTabSpace.value = null; newAgentMachine.value = null; newProjectOpen.value = false }
})

// ------------------------------------------------------------ machine
// `machines` only exists with several machines; otherwise everything is local, as before.
const machineList = machineChoices
const machine = ref('')
const machineCfg = computed(() => (machineList.value ? machineList.value.find(m => m.key === machine.value) : undefined))
const online = machineOnline
const home = computed(() => (machineCfg.value ? machineCfg.value.home : appConfig.value.home))
const recents = computed(() => (machineCfg.value ? machineCfg.value.dirs : appConfig.value.dirs) || [])

function syncKind() {
  const list = machineList.value
  if (fixedMachine.value) machine.value = machineOf(fixedMachine.value)
  else if (list && !list.some(m => m.key === machine.value && online(m))) {
    const last = list.find(m => m.key === lastMachine.value && online(m))
    setMachine(last ? last.key : '')
  } else if (!list && machine.value) setMachine('')
  kind.value = selectedAgentKind(kind.value, kinds.value)
  if (!dir.value) dir.value = recents.value[0] || home.value || '~'
}
function setMachine(k: string) {
  if (machine.value === k) return
  machine.value = k
  dir.value = recents.value[0] || home.value || '~'
  browsing.value = false
  kind.value = ''
  syncKind()
}
function pickMachine(m: MachineConfig) {
  setMachine(m.key)
  lastMachine.value = m.key
}
watch(newAgentOpen, async (open) => {
  if (!open) return
  if (fixedMachine.value) {
    machine.value = machineOf(fixedMachine.value)
    dir.value = (newTabSpace.value ? spaceCwd(newTabSpace.value) : null) || dir.value
  }
  error.value = null
  browsing.value = false
  launching.value = false
  draft.value = null
  // Each opening starts on the user's first agent, or on a new project.
  kind.value = ''
  if (newProjectOpen.value) coordinator.value = true
  if (!newTabSpace.value) loadCoordinators()
  syncKind()
  await loadConfig()
  // Opened from a machine's "…" menu: that machine, once its config (home) is in.
  const want = newAgentMachine.value
  if (!fixedMachine.value && want !== null && machineList.value?.some(m => m.key === want && online(m))) setMachine(want)
  syncKind()
})
// A machine (re)connects while the sheet is open: its home folder.
watch(() => machines.value.map(m => `${m.key}:${m.status}`).join(','), async () => {
  if (!newAgentOpen.value || !machineList.value) return
  await loadConfig()
  syncKind()
})
watch(kinds, syncKind)
function pickCoordinator() {
  coordinator.value = true
  draft.value = null
  if (!projectCoordinators.value.some(c => c.project === coordProject.value)) coordProject.value = projectCoordinators.value[0]?.project ?? ''
}
function pickKind(k: string) {
  coordinator.value = false
  kind.value = k
}

// ------------------------------------------------------------ navigateur de dossiers
function chooseDir(d: string) {
  if (coordinator.value && draft.value) draft.value.path = d
  else dir.value = d
  browsing.value = false
}

function resetForm() {
  // A terminal created here must stay visible in the list.
  if (shell.value) showShells.value = true
  resume.value = false
  name.value = ''
  prompt.value = ''
}

// herdr-core answers once the first message was typed ('sent') or not ('skipped': a dialog
// to answer, a blocked or busy program). Sent: the chat shows it at once; else say so.
function afterFirstMessage(r: { pane_id: string, first_message?: string | null }, text: string) {
  if (r.first_message === 'sent') rememberFirstPrompt(r.pane_id, text)
  else if (r.first_message === 'queued') {
    toast(tl('The first message will be sent once you have answered the prompt.', 'Le premier message partira dès que tu auras répondu à la question.'))
  } else if (r.first_message === 'skipped') {
    toast(tl('The first message was not sent: answer the prompt in the terminal, then send it again.', 'Le premier message n’est pas parti : réponds à la question dans le terminal, puis renvoie-le.'), true)
  }
}

async function launch() {
  launching.value = true
  error.value = null
  try {
    // A new tab is a new terminal labelled for its space (no layout call).
    const sent = prompt.value
    const r = await api<{ pane_id: string, first_message?: string | null }>('/api/agents', {
      ...(machine.value ? { machine: machine.value } : {}),
      kind: kind.value,
      cwd: dir.value,
      name: name.value.trim(),
      ...(newTabSpace.value ? { workspace: newTabSpace.value } : {}),
      prompt: prompt.value,
      resume: resume.value && canResume.value,
    })
    afterFirstMessage(r, sent)
    resetForm()
    newAgentOpen.value = false
    haptic()
    navigateTo(panePath(r.pane_id))
    loadConfig()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    launching.value = false
  }
}
</script>

<template>
  <AppSheet v-model:open="open" :title="newTabSpace ? t('Start in a new tab') : coordinator ? tl('Project', 'Projet') : t(shell ? 'New terminal' : 'New agent')" tall screen>
    <div v-if="!browsing" class="sheet-form">
      <div v-if="newTabSpace" class="into-pane">
        <span class="tabmap" aria-hidden="true"><i class="cur" style="inset: 0" /></span>
        <span>
          <b>{{ t('New tab') }}</b>
          <small>{{ [targetWs?.label, machineList ? machineName(machine) : null].filter(Boolean).join(' · ') }}</small>
        </span>
      </div>
      <template v-else-if="machineList && !coordinator">
        <label class="field-label">{{ t('Machine') }}</label>
        <MachineChoice :machines="machineList" :model-value="machine" @pick="pickMachine" />
      </template>

      <label class="field-label">{{ t('Type') }}</label>
      <div class="segmented agent-kinds" :style="{ '--segment-count': kinds.length + (canCoordinate ? 1 : 0) }">
        <button v-for="k in kinds" :key="k" type="button" :class="{ on: !coordinator && k === kind }" :data-kind="k" @click="pickKind(k)">
          <AgentAvatar :agent="k === 'shell' ? null : k" /><span>{{ k === 'shell' ? 'Terminal' : kindLabel(k) }}</span>
        </button>
        <button v-if="canCoordinate" type="button" :class="{ on: coordinator }" data-kind="project" @click="pickCoordinator">
          <span class="avatar"><UIcon name="i-lucide-folder-git-2" /></span><span>{{ tl('Project', 'Projet') }}</span>
        </button>
      </div>

      <NewProjectForm
        v-if="coordinator" v-model:project="coordProject" v-model:agent="coordAgent" v-model:draft="draft" :machine="machine" :machines="machineList"
        @settings="open = false" @browse="browsing = true" @machine="pickMachine"
      />
      <template v-else>
        <label class="field-label">{{ t('Folder') }}</label>
        <DirField :key="machine" v-model="dir" :recents="recents" @browse="browsing = true" />

        <label v-if="canResume" class="toggle-row">
          <span><b>{{ t('Resume the last conversation') }}</b><small>{{ t('for this agent in this folder') }}</small></span>
          <USwitch v-model="resume" color="success" size="xl" />
        </label>

        <label class="field-label" for="newPrompt">{{ t(shell ? 'Command to run' : 'First message') }} <span class="muted">{{ t('(optional)') }}</span></label>
        <UTextarea
          id="newPrompt" v-model="prompt" :rows="2" autoresize size="xl" class="w-full" :class="{ mono: shell }"
          :placeholder="t(shell ? 'E.g. npm run dev' : 'E.g. Summarize the project TODOs')"
        />

        <template v-if="!shell">
          <label class="field-label" for="newName">{{ t('Name') }} <span class="muted">{{ t('(optional)') }}</span></label>
          <UInput
            id="newName" v-model="name" size="xl" class="w-full" autocapitalize="none" autocorrect="off"
            :spellcheck="false" placeholder="reviewer" maxlength="60"
          />
        </template>
      </template>
    </div>

    <DirBrowser v-else :start="coordinator && draft ? (draft.probe?.exists ? draft.probe.path : null) : dir" :machine="machine" @choose="chooseDir" @cancel="browsing = false" />

    <template #footer>
      <NewProjectActions
        v-if="coordinator && !browsing" :project="coordProject" :agent="coordAgent" :draft="draft"
        @done="open = false" @added="k => { draft = null; coordProject = k }"
      />
      <div v-else-if="!browsing" class="sheet-form">
        <p v-if="error" class="form-error">{{ t(error) }}</p>
        <UButton block size="xl" color="primary" variant="solid" class="launch-btn hw-cta" icon="i-lucide-play" :loading="launching" :disabled="!kind" @click="launch">
          {{ launching ? t('Starting…') : t('Launch') }}
        </UButton>
      </div>
    </template>
  </AppSheet>
</template>
