<script setup lang="ts">
// The pane's real terminal in a modal window, fitted with the same size lease as
// Terminal view. The scrim of the other windows covers the app and keeps the focus
// here. Escape belongs to the agent: only the Close button or a click on the scrim
// closes the window, and closing only releases the lease.
const props = defineProps<{ paneId: string, active: boolean, title?: string }>()
const emit = defineEmits<{ close: [] }>()
const banner = shallowRef<Banner | null>(null)
const ctl = createTerminal(props.paneId, {
  setBanner: b => { banner.value = b },
  hasBanner: () => Boolean(banner.value),
  fill: () => true,
  input: () => props.active,
})
watch(pageVisible, v => ctl.setVisible(v))

// Computer: the keys go to the terminal as soon as it is ready. Phone: the window
// itself takes the focus, so the keyboard only opens on a tap in the terminal.
let opened = false
function focusTerminal() {
  if (!opened || !desk.value || ctl.hasFocus()) return
  const el = document.activeElement
  if (el instanceof HTMLElement && el.closest('.interactive-terminal') && el.matches('button, input, textarea')) return
  ctl.focus()
}
function onOpenAutoFocus(e: Event) {
  e.preventDefault()
  opened = true
  ;(e.currentTarget as HTMLElement | null)?.focus()
  setTimeout(focusTerminal, 50)
}
watch(() => ctl.loading.value, (loading) => { if (!loading) nextTick(focusTerminal) })
const content = {
  onOpenAutoFocus,
  onEscapeKeyDown: (e: Event) => e.preventDefault(),
}
const ui = { overlay: 'hw-scrim interactive-terminal-scrim', content: 'interactive-terminal' }
</script>

<template>
  <UModal
    open :title="tl('Interactive terminal', 'Terminal interactif')" :content="content" :ui="ui"
    @update:open="$event || emit('close')"
  >
    <template #content>
      <header class="interactive-terminal-head" @keydown.stop>
        <span><UIcon name="i-lucide-square-terminal" />{{ tl('Interactive terminal', 'Terminal interactif') }}<small v-if="title">{{ title }}</small></span>
        <UButton icon="i-lucide-x" color="neutral" variant="ghost" :aria-label="tl('Close terminal window', 'Fermer la fenêtre terminal')" @click="emit('close')" />
      </header>
      <p class="interactive-terminal-note">{{ tl('Live agent screen · closes when the message field returns', 'Écran réel de l’agent · se ferme au retour du champ libre') }}</p>
      <div v-if="banner" class="term-banner">
        <span>{{ banner.text }}</span>
        <UButton size="xs" color="warning" variant="outline" @click="banner.fn()">{{ banner.btn }}</UButton>
      </div>
      <TerminalView :ctl="ctl" @keydown.stop />
      <Keybar :ctl="ctl" :compact="!desk && !tablet" all-digits @keydown.stop />
    </template>
  </UModal>
</template>
