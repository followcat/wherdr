<script setup lang="ts">
// Shell: agent list (sidebar on a computer) + current page
// (agent, settings), windows, lock screen, network banner.
import { en, fr } from '@nuxt/ui/locale'

setToaster(useToast())
const route = useRoute()
const router = useRouter()
const isHome = computed(() => route.path === '/' || route.path === '')
const searchOpen = ref(false)
function openSearch() { searchOpen.value = true }
function closeListDrawer() { listDrawer.value = false }

useHead({
  htmlAttrs: { lang: language, class: computed(() => (activeTheme.value.def.light ? 'light' : 'dark')) },
  meta: [
    { name: 'description', content: tl('Control your Herdr code agents', 'Piloter ses agents de code Herdr') },
    { key: 'theme-color', name: 'theme-color', content: themeColor },
    { key: 'color-scheme', name: 'color-scheme', content: computed(() => (activeTheme.value.def.light ? 'light' : 'dark')) },
  ],
  // The demo build (wherdr.dev/demo) is not installable.
  link: import.meta.env.VITE_WHERDR_DEMO === '1' ? [] : [{ rel: 'manifest', href: language === 'en' ? '/manifest-en.webmanifest' : '/manifest.webmanifest' }],
})

// Sockets do not survive a locked phone or a frozen page. The probe decides:
// a live socket is reused for free, a zombie is recycled before the UI sits
// dead on it. Runs on every plausible wake-up signal -- some builds skip
// visibilitychange on unlock, and 'online' is the only hint that the radio
// is back after the network dropped.
function recoverSockets() {
  if (document.hidden) return
  pageVisible.value = true
  socketWake.value++
  void recoverEvents()
}
function onVisibility() {
  pageVisible.value = !document.hidden
  sendViewing()
  // iOS freezes the page in the background and cuts the sockets: we reconnect on return.
  recoverSockets()
  // Back in the foreground: the server may end a session past its maximum duration.
  if (!document.hidden && !locked.value) {
    if (mayReadOffline(readOfflineAccess())) confirmLock({ resume: true })
    else start({ resume: true })
  }
}
// Keyboard shortcuts (computer): utils/shortcuts.ts, composables/useShortcuts.ts.
useShortcuts(searchOpen)

// File dropped outside a drop zone: the browser would open it instead
// of the app. The zones (agent view) take it first; here, we refuse the rest.
function blockFileDrop(e: DragEvent) {
  if (!carriesFiles(e.dataTransfer) || e.defaultPrevented) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
}

// Keyboard (computer): Escape closes the open window (handled by the modals).
onMounted(() => {
  installViewport()
  notificationHeartbeat = setInterval(sendViewing, 10000)
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(event, noteNotificationActivity, { passive: true })
  window.addEventListener('focus', noteNotificationActivity)
  window.addEventListener('blur', sendViewing)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pageshow', recoverSockets)
  window.addEventListener('focus', recoverSockets)
  window.addEventListener('online', recoverSockets)
  window.addEventListener('dragover', blockFileDrop)
  window.addEventListener('drop', blockFileDrop)
  registerServiceWorker()
  if ('serviceWorker' in navigator) {
    // A tap on a notification while the app is open: the SW asks us to go there.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'navigate' && e.data.url) {
        const hash = new URL(e.data.url, location.href).hash
        router.push(hash.replace(/^#/, '') || '/')
      }
    })
  }
  start({ resume: true })
  // First launch: the setup guide, until finished or skipped (saved by the server).
  watch(locked, (l) => { if (!l) checkOnboarding() }, { immediate: true })
  // Local lease over: ask the server rather than locking on the browser's own
  // clock. Only the lease counts here: the deadline never locks the app while
  // it is open.
  leaseTimer = setInterval(() => {
    const access = readOfflineAccess()
    if (access?.enabled && !mayReadOffline({ enabled: true, expiresAt: access.expiresAt }) && !locked.value) start()
  }, 30000)
})
let notificationHeartbeat: ReturnType<typeof setInterval> | undefined
let leaseTimer: ReturnType<typeof setInterval> | undefined
onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('pageshow', recoverSockets)
  window.removeEventListener('focus', recoverSockets)
  window.removeEventListener('online', recoverSockets)
  window.removeEventListener('dragover', blockFileDrop)
  window.removeEventListener('drop', blockFileDrop)
  clearInterval(leaseTimer)
  clearInterval(notificationHeartbeat)
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.removeEventListener(event, noteNotificationActivity)
  window.removeEventListener('focus', noteNotificationActivity)
  window.removeEventListener('blur', sendViewing)
})
</script>

<template>
  <UApp :locale="language === 'fr' ? fr : en" :toaster="{ position: desk ? 'top-right' : 'top-center', max: 1, progress: false }">
    <HomeView v-show="desk || isHome" @search="openSearch" />
    <div v-if="desk && slim && listDrawer" class="list-scrim" aria-hidden="true" @click="closeListDrawer" />
    <GlobalSearch v-model:open="searchOpen" />
    <NuxtPage />
    <NewAgentSheet />
    <MenuSheet />
    <RenameSheet />
    <CommandResultSheet />
    <ConfirmSheet />
    <PluginResultSheet />
    <ImageLightbox />
    <ShortcutsSheet />
    <OnboardingGuide v-if="onboardingOpen && !locked" />
    <NewVersionBanner v-if="!locked" />
    <SelfUpdateScreen v-if="selfUpdate.open" />
    <LockScreen v-if="locked" />
  </UApp>
</template>
