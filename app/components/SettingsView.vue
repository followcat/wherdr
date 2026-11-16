<script setup lang="ts">
// Settings, in sections: appearance, conversation, terminal, agents (with pace), machines,
// notifications, security (passkey), shortcuts, about.
import type { ThemeDef, ThemeGroup, ThemeMode } from '~/utils/themes'
import type { TypingSpeed } from '~/utils/typewriter'
import { SETTINGS_ALIASES, SETTINGS_SECTIONS, settingsBack } from '~/utils/settingsNav'
import { CONVERSATION_TABS, conversationTab, type ConversationTab } from '#shared/appLinks'
import type { SettingsSection } from '~/utils/settingsNav'
import { type QuietDuration, type QuietScope, quietUntil } from '#shared/quiet'
import { quietPeriodEnd } from '~/utils/quietPeriodEnd'
import { ENGINES } from '~/utils/dictation/registry'
import { DEFAULT_MAX_SESSION_DAYS, MAX_SESSION_DAYS, type MaxSessionDays } from '#shared/sessionLimit'
import { APP_START_DEFAULT, readAppStart, writeAppStart, type AppStart } from '#shared/appStart'
import { chatFilesLevel, type ChatFilesLevel } from '#shared/chatFiles'
import { projectTarget, uiTarget, uiTargetName, type UiTargetId } from '#shared/uiTargets'
import { followElement, showHalo, waitForElement } from '~/utils/uiHalo'

// panel: beside the conversation on a wide computer (utils/settingsPanel.ts);
// the section lives in the conversation's URL, the full page stays one click away.
const props = defineProps<{ panel?: boolean }>()
const router = useRouter()
// The build's version (shared/v3Version.ts), also in /api/health.
const appVersion = useRuntimeConfig().public.version
// Sections: sidebar on a computer (one section shown), iOS Settings-style
// list on the phone (a tap opens the section, Back returns to the list).
// The section lives in the URL (`?section=terminal`):
// on the phone, opening it adds a history entry, which the system Back button
// pops like the header's; on a computer, it replaces the entry.
const route = useRoute()
watch(() => [route.path, route.query.section], () => {
  if (route.query.section === 'desktop' || route.path === '/settings/desktop') {
    router.replace({ path: props.panel ? route.path : '/settings', query: { ...route.query, section: 'conversation' } })
  }
}, { immediate: true })
const alias = computed(() => SETTINGS_ALIASES[String(route.query.section)] ?? null)
const section = computed<SettingsSection | null>(() => alias.value?.section ?? ((SETTINGS_SECTIONS as readonly string[]).includes(String(route.query.section)) ? route.query.section as SettingsSection : null))
const sectionIcons: Record<SettingsSection, string> = {
  appearance: 'i-lucide-palette', conversation: 'i-lucide-message-square', terminal: 'i-lucide-square-terminal',
  agents: 'i-lucide-bot', machines: 'i-lucide-server', projects: 'i-lucide-kanban', plugins: 'i-lucide-puzzle', phone: 'i-lucide-smartphone', notifications: 'i-lucide-bell', security: 'i-lucide-lock', shortcuts: 'i-lucide-keyboard', about: 'i-lucide-info',
}
const sectionLabels: Record<SettingsSection, string> = {
  appearance: 'Appearance', conversation: 'Conversation', terminal: 'Terminal', agents: 'Agents', machines: 'Machines', projects: 'Projects',
  plugins: 'Plugins', phone: 'Phone', notifications: 'Notifications', security: 'Security', shortcuts: 'Shortcuts', about: 'About',
}
const sections = computed(() => SETTINGS_SECTIONS
  .filter(id => id !== 'shortcuts' || (desk.value && !coarse.value))
  // Plugins are on hold: the section shows only once a plugin is installed
  // (DATA_DIR/plugins). Drop this line to always show it again.
  .filter(id => id !== 'plugins' || clientPlugins.value.length > 0)
  .map(id => ({ id, label: t(sectionLabels[id]), icon: sectionIcons[id] })))
const activeSection = computed<SettingsSection | null>(() => {
  if (section.value && sections.value.some(s => s.id === section.value)) return section.value
  return desk.value ? 'appearance' : null
})
// Conversation's tabs, the one shown in the URL (`&tab=dictation`).
const convTab = computed(() => conversationTab(route.query.tab))
const CONV_TAB_LABEL: Record<ConversationTab, string> = { 'display': 'Display', 'dictation': 'Dictation', 'read-aloud': 'Read aloud' }
const openConvTab = (tab: ConversationTab) => router.replace({ query: { ...route.query, tab, target: undefined } })
const activeLabel = computed(() => sections.value.find(s => s.id === activeSection.value)?.label || t('Settings'))
const body = ref<HTMLElement | null>(null)
// A new section (or Conversation tab) starts at the top. A target
// (`&target=appearance.theme`, shared/uiTargets.ts; an alias such as
// ?section=pacing names one) is waited for, scrolled to, kept in place while
// the groups above finish loading, and highlighted (utils/uiHalo.ts). Not
// shown (a feature off): the section's note says so, highlighted instead.
// A project's target is the project sheet's (ProjectSheet.vue).
const target = computed(() => {
  const id = uiTarget(route.query.target) ?? uiTarget(alias.value?.target)
  return id && !projectTarget(id) ? id : null
})
const pointed = ref<UiTargetId | null>(null)
const missing = ref<UiTargetId | null>(null)
const missingNote = ref<HTMLElement | null>(null)
const targetNote = computed(() => {
  const id = pointed.value ?? missing.value
  if (!id) return ''
  const name = uiTargetName(id)
  if (missing.value) return `${name} ${t('is not shown here.')}`
  return openedBy.value ? `${openedBy.value} ${t('points to')} ${name}` : `${t('Pointing to')} ${name}`
})
let stopFollow = () => {}
let endHalo = () => {}
let pointing = 0
// body: a direct load points once the column is mounted.
watch(() => `${route.query.section}|${route.query.section === 'conversation' ? convTab.value : ''}|${target.value ?? ''}|${!!body.value}`, () => nextTick(async () => {
  stopFollow()
  endHalo()
  pointed.value = missing.value = null
  const b = body.value
  if (!b) return
  b.scrollTop = 0
  const id = target.value
  if (!id) return
  const run = ++pointing
  const el = await waitForElement(b, `[data-ui-target="${id}"]`)
  if (run !== pointing) return
  if (!el) {
    missing.value = id
    await nextTick()
    if (missingNote.value) endHalo = showHalo(missingNote.value)
    return
  }
  pointed.value = id
  el.setAttribute('aria-describedby', 'ui-target-note')
  stopFollow = followElement(b, el)
  endHalo = showHalo(el)
}), { immediate: true })
onBeforeUnmount(() => { pointing++; stopFollow(); endHalo() })
function openSection(id: SettingsSection) {
  if (id === section.value) return
  const to = { path: props.panel ? route.path : '/settings', query: { section: id } }
  if (desk.value) router.replace(to)
  else router.push(to)
}
// Opened by an agent's `ui open` (AgentView.vue): its name, while its section shows.
const openedBy = computed(() => {
  const o = uiOpenedBy.value
  return props.panel && o && o.section === route.query.section ? o.by : null
})
if (props.panel) onBeforeUnmount(() => { uiOpenedBy.value = null })
// Side panel too narrow for labels (main.css container query): the rail can show them
// anyway, a choice kept on the device.
const RAIL_LABELS_KEY = 'settingsRailLabels'
const railLabels = ref(false)
onMounted(() => { try { railLabels.value = localStorage.getItem(RAIL_LABELS_KEY) === '1' } catch {} })
function toggleRailLabels() {
  railLabels.value = !railLabels.value
  try { localStorage.setItem(RAIL_LABELS_KEY, railLabels.value ? '1' : '0') } catch {}
}
function closePanel() {
  const { section: _s, project: _p, tab: _t, review: _r, library: _l, group: _g, target: _x, ...query } = route.query
  router.replace({ query })
}
function openFullPage() {
  fullSettingsOnce.value = true
  navigateTo({ path: '/settings', query: route.query })
}
// Escape closes the panel first, unless a window or menu is open or the key is
// typed in the conversation (message field, terminal). Capture phase: the
// conversation's own Escape (Stop, the Your turn card) waits for the next press.
function onPanelKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
  if (anySheetOpen.value || document.querySelector('[role="dialog"], [role="alertdialog"]')) return
  // HeaderMenu closes its menu with a fake Escape sent to the document: not for us.
  const el = e.target instanceof Element ? e.target : null
  if (!el || el.closest('[role="menu"], [role="listbox"]')) return
  if (!el.closest('#settings') && (el.closest('.xterm') || el.matches('input, textarea, [contenteditable="true"]'))) return
  e.preventDefault()
  e.stopPropagation()
  closePanel()
}
if (props.panel) {
  onMounted(() => document.addEventListener('keydown', onPanelKey, true))
  onBeforeUnmount(() => document.removeEventListener('keydown', onPanelKey, true))
}
function back() {
  const to = settingsBack({ desk: desk.value, section: section.value, historyBack: (history.state as { back?: unknown } | null)?.back })
  if (to === 'list') router.replace('/settings')
  else if (to === 'history') router.back()
  else navigateTo('/', { replace: true })
}
// Phone, Settings opened first (app launched, link, reload): nothing
// underneath, the system Back button would close the app. We slip the home screen
// underneath, as if we came from the agent list.
onMounted(async () => {
  if (props.panel || desk.value || typeof (history.state as { back?: unknown } | null)?.back === 'string') return
  const here = route.fullPath
  await router.replace('/')
  await router.push(here)
})
// Global refs bound in the template: local (assignable) aliases.
const countersOn = showCounters
const quotasOn = showQuotas
const autoReorderOn = autoReorderReady
const encryptedOn = encryptedText
const agentClipboardOn = agentClipboard
// Dictation: Off, then the engines this build has (utils/dictation/registry.ts). Per device.
const dictationChoice = dictationEngine
const dictationItems = computed(() => {
  const engines: Record<string, { label: string, description: string }> = {
    device: { label: tl('On this device', 'Sur cet appareil'), description: tl('Nothing leaves the device; the model is downloaded once.', 'Rien ne quitte l’appareil ; le modèle est téléchargé une fois.') },
    cloud: { label: tl('Online (OpenRouter)', 'En ligne (OpenRouter)'), description: tl('The audio goes through the wherdr server to OpenRouter.', 'L’audio passe par le serveur wherdr vers OpenRouter.') },
  }
  return [
    { label: tl('Off', 'Désactivée'), description: tl('No mic in the message field. Default.', 'Pas de micro dans le champ de message. Par défaut.'), value: 'off' },
    ...Object.keys(ENGINES).map(id => ({ ...engines[id]!, value: id })),
  ]
})
// Forced off if the system reduces motion: shown disabled.
const typewriter = computed({ get: () => typingSpeed.value, set: (v: TypingSpeed) => { typewriterSpeed.value = v } })
const typingItems = computed(() => [
  { label: t('Off'), description: t('The reply appears at once.'), value: 'off' },
  { label: t('Fast'), description: t('Original speed · 0.5 to 2 s.'), value: 'fast' },
  { label: t('Medium'), description: t('Twice as slow · 1 to 4 s.'), value: 'medium' },
  { label: t('Slow'), description: t('Three times as slow · 1.5 to 6 s.'), value: 'slow' },
])
const renderer = terminalRenderer
const smoothScrollingOn = smoothTouchScrolling
const width = contentWidth
// Interface size › Large widens the reading column to 1500 px for Normal and
// Wide alike (Content width › Full still wins); what keeps differing is the
// width the terminal itself is fitted to — the copy says which is which.
const widthItems = computed(() => uiScale.value === 'lg'
  ? [
      { label: t('Normal'), description: t('Reading column up to 1500 px · terminal fitted to 760 px.'), value: 'normal' },
      { label: t('Wide'), description: t('Reading column up to 1500 px · terminal fitted to 1100 px.'), value: 'wide' },
      { label: t('Full width'), description: t('The whole width, terminal included.'), value: 'full' },
    ]
  : [
      { label: t('Normal'), description: t('760 px column · terminal fitted to width.'), value: 'normal' },
      { label: t('Wide'), description: t('Up to 1100 px · terminal fitted to width.'), value: 'wide' },
      { label: t('Full width'), description: t('The whole width, terminal included.'), value: 'full' },
    ])
const scale = uiScale
const scaleItems = computed(() => [
  { label: t('Standard'), description: t('The usual density.'), value: 'md' },
  { label: t('Large'), description: t('Interface and text enlarged by about 15%, terminal included; the terminal text size stays the base.'), value: 'lg' },
])
// What an agent pane opens on: the Conversation, or the Terminal.
const defaultPane = defaultViewMode
const defaultPaneItems = [
  { label: t('Conversation'), description: t('Read the transcript first.'), value: 'chat' },
  { label: t('Terminal'), description: t('Type straight into the pane.'), value: 'term' },
]
const quotaMode = quotaDisplay
const quotaItems = computed(() => [
  { label: t('Remaining'), description: t('What is left in each window, like Codex.'), value: 'left' },
  { label: t('Used'), description: t('What has been used, like Claude.'), value: 'used' },
])

// ------------------------------------------------------------ notifications
const subscribed = pushOn
const refreshPush = refreshPushOn

// Quiet mode: scope (this device = its subscription, or all) and duration.
// The server keeps the setting and filters before sending (shared/quiet.ts).
const quietScope = ref<QuietScope>('all')
const quietDuration = ref<QuietDuration>('manual')
const quietScopeItems = computed(() => [
  { label: tl('This device', 'Cet appareil'), value: 'device', disabled: !subscribed.value },
  { label: tl('All devices', 'Tous les appareils'), value: 'all' },
])
const quietDurationItems = [
  { label: tl('1 hour', '1 heure'), value: 'hour' },
  { label: tl('Until tomorrow morning (8 am)', 'Jusqu’à demain matin (8 h)'), value: 'morning' },
  { label: tl('Until turned back on', 'Jusqu’à réactivation'), value: 'manual' },
]
watch(quietCurrent, (cur) => {
  if (!cur) return
  quietScope.value = cur.scope
  const left = cur.quiet.until === null ? null : cur.quiet.until - Date.now()
  quietDuration.value = left === null ? 'manual' : left <= 3600 * 1000 ? 'hour' : 'morning'
}, { immediate: true })
async function applyQuiet(on: boolean) {
  try {
    const previous = quietCurrent.value?.scope
    if (on) await setQuiet(quietScope.value, true, quietUntil(quietDuration.value))
    // Scope change: the old quiet period stops.
    if (previous && (!on || previous !== quietScope.value)) await setQuiet(previous, false)
  } catch (err) { toast((err as Error).message, true) }
}
const quietOn = computed({
  get: () => Boolean(quietCurrent.value),
  set: (v: boolean) => { applyQuiet(v) },
})
function pickQuietScope(v: QuietScope) { quietScope.value = v; if (quietOn.value) applyQuiet(true) }
function pickQuietDuration(v: QuietDuration) { quietDuration.value = v; if (quietOn.value) applyQuiet(true) }
const quietEnd = computed(() => {
  const cur = quietCurrent.value
  if (!cur) return ''
  const who = cur.scope === 'all' ? tl('all devices', 'tous les appareils') : tl('this device', 'cet appareil')
  const end = quietPeriodEnd(cur.quiet, quietNow.value)
  if (end.kind === 'manual') return tl(`Silenced on ${who} until turned back on.`, `Silence sur ${who} jusqu’à réactivation.`)
  const time = new Date(end.at).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  if (end.kind === 'today') return tl(`Silenced on ${who} until ${time}.`, `Silence sur ${who} jusqu’à ${time}.`)
  if (end.kind === 'tomorrow') return tl(`Silenced on ${who} until tomorrow ${time}.`, `Silence sur ${who} jusqu’à demain ${time}.`)
  const day = new Date(end.at).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short' })
  return tl(`Silenced on ${who} until ${day} ${time}.`, `Silence sur ${who} jusqu’au ${day} ${time}.`)
})

// ------------------------------------------------------------ theme
// Picker section titles: brand names stay as is.
const themeGroupLabel = (g: ThemeGroup) => (g === 'agents' ? t('Agents') : g === 'classic' ? t('Classic') : g === 'custom' ? tl('Custom') : 'wherdr')
// Preview in the mode shown: background, surface, line, text, accent, states (working, waiting, done).
const swatches = (th: ThemeDef) => {
  const c = activeTheme.value.light ? th.light : th.c
  return [c.bg, c.surface, c.line, c.text, c.accent, c.blue, c.rose, c.teal]
}
const modeItems = computed(() => [
  { value: 'dark' as ThemeMode, label: t('Dark'), icon: 'i-lucide-moon' },
  { value: 'light' as ThemeMode, label: t('Light'), icon: 'i-lucide-sun' },
  { value: 'system' as ThemeMode, label: t('System'), icon: 'i-lucide-monitor' },
])
function pickMode(m: ThemeMode) {
  themeMode.value = m
  haptic()
}
const themesOpen = ref(false)
const currentTheme = computed(() => findTheme(themeChoice.value))
const currentLabel = computed(() => (currentTheme.value ? currentTheme.value.label : themeChoice.value))
function pickTheme(id: string) {
  themeChoice.value = id
  haptic()
}
// Custom themes: the editor opens on a theme (a custom one is edited, any other starts a new one).
const editorOpen = ref(false)
const editorBase = ref<ThemeDef | null>(null)
function openEditor(th: ThemeDef | undefined) {
  editorBase.value = th || themeById(DEFAULT_THEME)!
  editorOpen.value = true
}
const importOpen = ref(false)
const importText = ref('')
const importError = ref('')
async function importFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) importText.value = file.size > THEME_FILE_MAX ? '' : await file.text()
  importError.value = file && file.size > THEME_FILE_MAX ? tl(`The file is larger than ${THEME_FILE_MAX / 1024} KB`) : ''
}
function importTheme() {
  const th = importThemeText(importText.value)
  if (typeof th === 'string') { importError.value = tl(th); return }
  if (!saveCustomTheme(th)) return
  importOpen.value = false
  toast(tl(`Theme ${th.label} imported`))
}

// ------------------------------------------------------------ texte du terminal
const changeFont = (d: number) => { fontSize.value = Math.max(8, Math.min(20, fontSize.value + d)) }
const rendererItems = [
  { label: 'WebGL', value: 'webgl' },
  { label: 'HTML', value: 'html' },
]
const rendererStatus = computed(() => terminalRenderStatus.value === 'html-fallback'
  ? t('Active rendering: HTML (WebGL unavailable)')
  : terminalRenderStatus.value === 'html'
    ? t('Active rendering: HTML')
    : t('Active rendering: WebGL'))
watch(renderer, refreshTerminalRenderStatus)

// ------------------------------------------------------------ security
// The passkey card (PasskeyCard.vue) shares this state.
const sec = authStatus
const refreshSecurity = refreshAuthStatus
// Maximum duration since the passkey unlock (server setting, every device).
const maxSessionItems = computed(() => MAX_SESSION_DAYS.map(d => ({
  label: d === 1 ? t('1 day') : d === 365 ? t('1 year') : tl(`${d} days`, `${d} jours`),
  value: d,
})))
const maxSession = computed({
  get: () => sec.value?.maxSessionDays ?? DEFAULT_MAX_SESSION_DAYS,
  set: async (days: MaxSessionDays) => {
    try {
      await api('/api/auth/max-session', { days })
      // Reducing it can move this session's deadline: read it back.
      await confirmLock()
    } catch (err) { toast((err as Error).message, true) }
    refreshSecurity()
  },
})
// When this device must unlock again (client clock), shown under the setting.
const deadlineText = computed(() => {
  const st = sec.value
  if (!st?.deadline) return ''
  const when = new Date(st.deadline + Date.now() - (st.now ?? Date.now()))
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return tl(`This device asks for the passkey again at the first opening after ${when}.`, `Cet appareil redemandera la clé d’accès à la première ouverture après le ${when}.`)
})

// Files shown from conversations (shared/chatFiles.ts): applied by the server.
// Picking the default saves nothing, so it keeps following the exposure.
const publicExposure = computed(() => Boolean(appConfig.value.publicExposure))
const chatFilesSaved = syncedRef<string | null>('chatFilesLevel', raw => raw, v => v)
const chatFiles = computed({
  get: () => chatFilesLevel(chatFilesSaved.value, publicExposure.value),
  set: (v: ChatFilesLevel) => { chatFilesSaved.value = v === chatFilesLevel(null, publicExposure.value) ? null : v },
})
const chatFilesItems = computed(() => [
  { label: t('Everything my user can read'), description: publicExposure.value ? t('Not recommended: wherdr is reachable from the Internet.') : t('Default while wherdr answers only this computer and your tailnet.'), value: 'all' },
  { label: t('Home and the agents’ temporary folders'), description: publicExposure.value ? t('Default while wherdr is reachable from the Internet.') : t('Your home folder, /tmp, /var/tmp and /var/folders.'), value: 'temp' },
  { label: t('Home only'), description: t('Only files in your home folder.'), value: 'home' },
])
const chatFilesProtected = syncedRef('chatFilesProtected', flag.read(false), flag.write)

// How this device opens the app (shared/appStart.ts): kept where the service
// worker reads it, nothing on the server.
const appStartItems = [
  { label: t('Up to date'), description: t('Network first: always the current version, the saved copy only past 3 s without an answer. Default.'), value: 'network' },
  { label: t('Instant'), description: t('Saved copy first: opens at once, even on a weak network; a Reload banner announces a newer version.'), value: 'cache' },
]
const appStartChoice = ref<AppStart>(APP_START_DEFAULT)
const appStart = computed({
  get: () => appStartChoice.value,
  set: (value: AppStart) => {
    appStartChoice.value = value
    writeAppStart(caches, value).catch(() => toast(t('Could not save this choice on this device.'), true))
  },
})

onMounted(() => {
  if (typeof caches !== 'undefined') readAppStart(caches).then((v) => { appStartChoice.value = v })
  refreshTerminalRenderStatus()
  loadConfig()
  refreshPush().then(refreshQuiet)
  refreshSecurity()
})
</script>

<template>
  <section id="settings" data-wherdr="settings" class="view settings-view" :class="{ 'settings-panel': panel }" :aria-label="panel ? t('Settings') : undefined">
    <SidePanelHandle v-if="panel" />
    <header class="top bar settings-top">
      <UButton v-if="!panel" icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('Back')" @click="back" />
      <h2>{{ desk ? t('Settings') : activeLabel }}<span v-if="openedBy" class="settings-opened-by">{{ tl(`Opened by ${openedBy}`) }}</span></h2>
      <template v-if="panel">
        <UButton icon="i-lucide-maximize-2" color="neutral" variant="ghost" size="lg" class="icon-btn settings-panel-full" :aria-label="t('Open full page')" :title="t('Open full page')" @click="openFullPage" />
        <UButton icon="i-lucide-panel-right-close" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('Close settings')" :title="t('Close settings')" @click="closePanel" />
      </template>
    </header>
    <div class="settings-layout" :class="{ 'section-open': activeSection }">
      <nav class="settings-nav" :class="{ 'rail-labels': panel && railLabels }" :aria-label="t('Settings sections')">
        <button
          v-for="item in sections" :key="item.id" type="button" class="settings-nav-item"
          :class="{ selected: activeSection === item.id }" :title="panel ? item.label : undefined" :aria-label="panel ? item.label : undefined" :aria-current="activeSection === item.id ? 'page' : undefined"
          @click="openSection(item.id)"
        >
          <UIcon :name="item.icon" /><span>{{ item.label }}</span><UIcon name="i-lucide-chevron-right" class="settings-nav-arrow" />
        </button>
        <button
          v-if="panel" type="button" class="settings-rail-toggle" :aria-pressed="railLabels"
          :aria-label="t('Show section names')" :title="t('Show section names')"
          @click="toggleRailLabels"
        >
          <UIcon :name="railLabels ? 'i-lucide-chevrons-left' : 'i-lucide-chevrons-right'" />
        </button>
      </nav>
      <div v-show="activeSection" ref="body" class="settings-body">
        <div class="settings-column">
        <h2 class="settings-section-title">{{ activeLabel }}</h2>
        <p v-if="missing" ref="missingNote" class="muted settings-hint ui-target-missing">{{ targetNote }}</p>
        <p v-else id="ui-target-note" class="sr-only" role="status" aria-live="polite">{{ targetNote }}</p>

        <div v-show="activeSection === 'appearance'" class="settings-section">
          <div data-ui-target="appearance.theme" class="settings-group">
            <h3>{{ t('Theme') }}</h3>
            <div class="segmented theme-mode" role="radiogroup" :aria-label="t('Mode')" style="--segment-count: 3">
              <button v-for="m in modeItems" :key="m.value" type="button" role="radio" :class="{ on: themeMode === m.value }" :aria-checked="themeMode === m.value" @click="pickMode(m.value)">
                <UIcon :name="m.icon" /><span>{{ m.label }}</span>
              </button>
            </div>
            <!-- Collapsed by default: the current theme shows, a tap expands the list. -->
            <button type="button" class="theme-opt theme-current" :aria-expanded="themesOpen" @click="themesOpen = !themesOpen">
              <span class="theme-sw"><i v-for="(c, i) in currentTheme ? swatches(currentTheme) : []" :key="i" :style="{ background: c }" /></span>
              <span class="theme-name">{{ currentLabel }}<small>{{ t(themesOpen ? 'Hide themes' : 'Change theme') }}</small></span>
              <UIcon :name="themesOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="theme-check" />
            </button>
            <div v-show="themesOpen" class="theme-list" role="radiogroup" :aria-label="t('Theme')">
              <section v-for="sec in themeSections(customThemes)" :key="sec.group" class="theme-section" :aria-label="themeGroupLabel(sec.group)">
                <h4 class="theme-section-title">{{ themeGroupLabel(sec.group) }}</h4>
                <div class="theme-grid">
                  <div v-for="th in sec.group === 'custom' ? sec.themes : []" :key="th.id" class="theme-custom">
                    <button type="button" role="radio" class="theme-opt" :class="{ on: themeChoice === th.id }" :aria-checked="themeChoice === th.id" @click="pickTheme(th.id)">
                      <span class="theme-sw"><i v-for="(c, i) in swatches(th)" :key="i" :style="{ background: c }" /></span>
                      <span class="theme-name">{{ th.label }}<small v-if="th.author">{{ th.author }}</small></span>
                    </button>
                    <button type="button" class="icon-btn" :aria-label="tl(`Edit ${th.label}`)" data-testid="theme-edit" @click="openEditor(th)"><UIcon name="i-lucide-pencil" /></button>
                  </div>
                  <button
                    v-for="th in sec.group === 'custom' ? [] : sec.themes" :key="th.id" type="button" role="radio" class="theme-opt" :class="{ on: themeChoice === th.id }"
                    :aria-checked="themeChoice === th.id" @click="pickTheme(th.id)"
                  >
                    <span class="theme-sw"><i v-for="(c, i) in swatches(th)" :key="i" :style="{ background: c }" /></span>
                    <span class="theme-name">{{ th.label }}<small v-if="th.id === DEFAULT_THEME">{{ t('default') }}</small></span>
                    <UIcon v-if="themeChoice === th.id" name="i-lucide-check" class="theme-check" />
                  </button>
                </div>
              </section>
              <div class="theme-tools">
                <UButton size="lg" color="neutral" variant="outline" icon="i-lucide-palette" data-testid="theme-create" @click="openEditor(currentTheme)">{{ tl('Create theme') }}</UButton>
                <UButton size="lg" color="neutral" variant="outline" icon="i-lucide-upload" @click="importText = ''; importError = ''; importOpen = true">{{ tl('Import theme') }}</UButton>
              </div>
            </div>
          </div>
          <ThemeEditor v-model:open="editorOpen" :base="editorBase" />
          <AppSheet v-model:open="importOpen" :title="tl('Import theme')" hide-close>
            <form class="sheet-form" @submit.prevent="importTheme">
              <label class="field-label" for="themeImport">{{ tl('Theme JSON') }}</label>
              <UTextarea id="themeImport" v-model="importText" :rows="8" class="w-full mono" :placeholder="tl('Paste a theme file, or pick one')" />
              <input type="file" accept=".json,application/json" class="w-full" :aria-label="tl('Theme file')" @change="importFile">
              <p v-if="importError" class="form-error" role="alert">{{ importError }}</p>
              <UButton type="submit" size="xl" color="primary" class="hw-cta" :disabled="!importText.trim()">{{ tl('Import') }}</UButton>
            </form>
          </AppSheet>
          <p class="muted settings-hint">{{ t('The theme and its mode follow you on every device. System follows the light or dark setting of this device.') }}</p>

          <div data-ui-target="appearance.home-screen" class="settings-group">
            <h3>{{ t('Home screen') }}</h3>
            <label class="settings-toggle">
              <span><b>{{ t('Reorder automatically') }}</b><small>{{ t('In Ready, show unread agents before read ones. Follows you on every device.') }}</small></span>
              <USwitch v-model="autoReorderOn" size="xl" />
            </label>
            <label class="settings-toggle">
              <span><b>{{ t('Show counters') }}</b><small>{{ t('Show agent counters on the home screen.') }}</small></span>
              <USwitch v-model="countersOn" size="xl" />
            </label>
            <label class="settings-toggle">
              <span><b>{{ t('Show quotas') }}</b><small>{{ t('Show Claude and Codex quotas on the home screen.') }}</small></span>
              <USwitch v-model="quotasOn" size="xl" />
            </label>
            <MachineBarSettings />
          </div>

          <div data-ui-target="appearance.quotas" class="settings-group">
            <h3>{{ t('Quotas') }}</h3>
            <URadioGroup v-model="quotaMode" :items="quotaItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
            <p class="muted settings-hint">{{ t('The color always flags a nearly exhausted quota. Follows you on every device.') }}</p>
          </div>

          <!-- Computer layout only (same threshold as the app: 900 px). -->
          <template v-if="desk">
            <div class="eyebrow settings-subhead"><span>{{ t('Desktop') }}</span></div>
            <div class="settings-group settings-width">
              <h3>{{ t('Content width') }}</h3>
              <URadioGroup v-model="width" :items="widthItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
              <p class="muted settings-hint">{{ t('Conversation, terminal, settings and other content. Saved on this device.') }}</p>
            </div>
            <div class="settings-group">
              <h3>{{ t('Interface size') }}</h3>
              <URadioGroup v-model="scale" :items="scaleItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
              <p class="muted settings-hint">{{ t('The agent side and its text, enlarged. Saved on this device.') }}</p>
            </div>
          </template>
        </div>

        <div v-show="activeSection === 'conversation'" class="settings-section">
          <div class="segmented settings-tabs" role="tablist" :aria-label="t('Conversation')" :style="{ '--segment-count': CONVERSATION_TABS.length }">
            <button v-for="k in CONVERSATION_TABS" :id="`conversation-tab-${k}`" :key="k" type="button" role="tab" :class="{ on: convTab === k }" :aria-selected="convTab === k" :aria-controls="`conversation-panel-${k}`" :data-tab="k" @click="openConvTab(k)">
              <span>{{ t(CONV_TAB_LABEL[k]) }}</span>
            </button>
          </div>
          <div v-show="convTab === 'display'" id="conversation-panel-display" role="tabpanel" aria-labelledby="conversation-tab-display">
            <div data-ui-target="conversation.default-pane" class="settings-group">
              <h3>{{ t('Default pane view') }}</h3>
              <URadioGroup v-model="defaultPane" :items="defaultPaneItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
              <p class="muted settings-hint">{{ t('What an agent pane opens on. A pane you switched to Terminal stays there. Follows you on every device.') }}</p>
            </div>
            <div data-ui-target="conversation.typewriter" class="settings-group settings-typing">
              <h3>{{ t('Typewriter') }}</h3>
              <URadioGroup v-model="typewriter" :items="typingItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" :disabled="reducedMotion" />
              <p class="muted settings-hint">{{ t(reducedMotion ? 'Off: the system asks for reduced motion.' : 'Only new replies are animated; history appears at once. Tap a reply while it types to show it in full. Follows you on every device.') }}</p>
              <label class="settings-toggle encrypted-toggle" :class="{ 'is-disabled': !typewriterActive }">
                <span><b>{{ t('Encrypted text') }}</b><small>{{ t('Writing advances in glyphs, then the text decrypts behind it.') }}</small></span>
                <USwitch v-model="encryptedOn" :disabled="!typewriterActive" size="xl" />
              </label>
              <SettingsPreview v-if="activeSection === 'conversation' && convTab === 'display'">
                <TypingPreview />
              </SettingsPreview>
            </div>
          </div>
          <div v-show="convTab === 'dictation'" id="conversation-panel-dictation" role="tabpanel" aria-labelledby="conversation-tab-dictation" class="settings-group" data-testid="dictation-settings" data-ui-target="conversation.dictation">
            <h3>{{ tl('Dictation', 'Dictée') }}</h3>
            <p class="muted settings-lead">{{ tl('A mic next to +: hold it and talk, or tap it to start and again to stop. The text goes into the field; nothing is sent on its own.', 'Un micro à côté de + : maintiens-le et parle, ou touche-le pour démarrer puis encore pour arrêter. Le texte va dans le champ ; rien n’est envoyé tout seul.') }}</p>
            <URadioGroup v-model="dictationChoice" :items="dictationItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
            <DictationDeviceSettings v-if="dictationChoice === 'device'" />
            <DictationCloudSettings v-if="dictationChoice === 'cloud'" />
            <DictationRewriteSettings v-if="dictationChoice !== 'off'" />
            <p class="muted settings-hint">{{ tl('Saved on this device.', 'Enregistré sur cet appareil.') }}</p>
          </div>
          <div v-show="convTab === 'read-aloud'" id="conversation-panel-read-aloud" role="tabpanel" aria-labelledby="conversation-tab-read-aloud" class="settings-group" data-testid="read-aloud-group" data-ui-target="conversation.read-aloud">
            <h3>{{ tl('Read aloud', 'Lecture à voix haute') }}</h3>
            <p class="muted settings-lead" data-testid="read-aloud-lead">{{ t('Turning it on adds a Play button under each reply, which reads it aloud: the words only, with “code block” in place of code. One reply at a time; tap Stop to end it. On iPhone, iOS may stop reading when the screen locks or you leave the app.') }}</p>
            <ReadAloudSettings />
            <p class="muted settings-hint">{{ tl('Saved on this device.', 'Enregistré sur cet appareil.') }}</p>
          </div>
        </div>

        <div v-show="activeSection === 'terminal'" class="settings-section">
          <div data-ui-target="terminal.text-size" class="settings-group">
            <h3>{{ t('Text') }}</h3>
            <div class="settings-stepper">
              <span>{{ t('Terminal text size') }}</span>
              <div>
                <button type="button" :aria-label="t('Decrease text size')" @click="changeFont(-1)">A−</button>
                <output>{{ fontSize }}</output>
                <button type="button" :aria-label="t('Increase text size')" @click="changeFont(1)">A+</button>
              </div>
            </div>
          </div>
          <div class="settings-group">
            <h3>{{ t('Clipboard') }}</h3>
            <label class="settings-toggle">
              <span><b>{{ t('Agent copies') }}</b><small>{{ t('Text an agent copies in the terminal (OSC 52) goes to this device’s clipboard. Never read from it. Saved on this device.') }}</small></span>
              <USwitch v-model="agentClipboardOn" size="xl" />
            </label>
          </div>
          <div class="settings-group">
            <label class="settings-toggle">
              <span><b>{{ t('Smooth touch scrolling (beta)') }}</b><small>{{ t('Experimental finger tracking and inertia. Saved on this device.') }}</small></span>
              <USwitch v-model="smoothScrollingOn" size="xl" />
            </label>
          </div>
          <div data-ui-target="terminal.rendering" class="settings-group settings-renderer">
            <h3>{{ t('Terminal rendering') }}</h3>
            <URadioGroup v-model="renderer" :items="rendererItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
            <p class="muted settings-hint">{{ t('Rendering is saved on this device.') }}</p>
            <p class="settings-renderer-status" role="status">{{ rendererStatus }}</p>
          </div>
          <PhoneKeyOrderSettings data-ui-target="terminal.key-order" />
        </div>

        <div v-show="activeSection === 'agents'" class="settings-section">
          <OfferedAgentsSettings />
          <ProxiesSettings />
          <div data-ui-target="agents.claude-quotas" id="claude-quotas" class="settings-group">
            <h3>{{ tl('Claude quotas', 'Quotas Claude') }}</h3>
            <ClaudeQuotaSetup v-if="activeSection === 'agents'" />
          </div>
          <PacingSettings id="settings-pace" data-ui-target="agents.pace" :active="activeSection === 'agents'" />
        </div>

        <div v-show="activeSection === 'machines'" class="settings-section" data-testid="settings-machines">
          <CoreMachines />
        </div>

        <div v-show="activeSection === 'notifications'" class="settings-section">
          <div class="settings-group" data-testid="notification-quiet" data-ui-target="notifications.do-not-disturb">
            <label class="settings-toggle quiet-toggle">
              <span><b><UIcon :name="quietOn ? 'i-lucide-bell-off' : 'i-lucide-bell'" />{{ tl('Do not disturb', 'Silence') }}</b><small>{{ tl('Turns off every notification, no exceptions: the rules below are ignored.', 'Coupe toutes les notifications, sans exception : les réglages ci-dessous sont ignorés.') }}</small></span>
              <USwitch v-model="quietOn" size="xl" />
            </label>
            <p class="notify-caption">{{ tl('Silence on', 'Couper pour') }}</p>
            <URadioGroup :model-value="quietScope" :items="quietScopeItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" @update:model-value="v => pickQuietScope(v as QuietScope)" />
            <p v-if="!subscribed" class="muted notify-hint">{{ tl('“This device” needs notifications turned on below.', '« Cet appareil » demande d’activer les notifications ci-dessous.') }}</p>
            <p class="notify-caption">{{ tl('Duration', 'Durée') }}</p>
            <URadioGroup :model-value="quietDuration" :items="quietDurationItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" @update:model-value="v => pickQuietDuration(v as QuietDuration)" />
            <p class="muted notify-hint" :class="{ 'quiet-end': quietOn }">{{ quietEnd || tl('Notifications come back on by themselves at the end.', 'Retour automatique à la normale à la fin de la durée choisie.') }}</p>
          </div>
          <NotificationRules />
          <div data-ui-target="notifications.device" class="settings-group">
            <h3>{{ tl('This device’s notifications', 'Notifications de cet appareil') }}</h3>
            <PushCard detailed />
            <PushDevices v-if="activeSection === 'notifications'" />
          </div>
        </div>

        <div v-show="activeSection === 'projects'" class="settings-section">
          <ProjectsSettings :active="activeSection === 'projects'" />
        </div>

        <div v-show="activeSection === 'plugins'" class="settings-section">
          <ClientPlugins data-wherdr="settings-plugins" />
        </div>

        <div v-show="activeSection === 'phone'" class="settings-section">
          <PhoneSetup data-ui-target="phone.setup" :active="activeSection === 'phone'" />
          <div data-ui-target="phone.app-start" class="settings-group">
            <h3>{{ t('App start') }}</h3>
            <URadioGroup v-model="appStart" :items="appStartItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
            <p class="muted settings-hint">{{ t('On this device only.') }}</p>
          </div>
        </div>

        <div v-show="activeSection === 'security'" class="settings-section">
          <div class="settings-group">
            <h3>{{ tl('Network access', 'Accès réseau') }}</h3>
            <OpenNetworkBanner />
            <p v-if="!appConfig.openNetwork" class="muted settings-hint">{{ tl('wherdr only answers this computer (localhost) and your own tailnet devices. A device on another network (a Wi-Fi, a LAN, the Internet) is refused, even with the address and the port, and so are other people\'s devices on your tailnet. A proxy or tunnel you run on this computer counts as this computer.', 'wherdr ne répond qu’à cet ordinateur (localhost) et à tes propres appareils du tailnet. Un appareil sur un autre réseau (un Wi-Fi, un réseau local, Internet) est refusé, même avec l’adresse et le port, comme les appareils des autres personnes de ton tailnet. Un proxy ou un tunnel que tu fais tourner sur cet ordinateur compte comme cet ordinateur.') }}</p>
            <NetworkTips />
          </div>
          <div class="settings-group">
            <h3>{{ t('Files shown from conversations') }}</h3>
            <URadioGroup v-model="chatFiles" :items="chatFilesItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
            <p v-if="chatFiles === 'all' && publicExposure" class="settings-hint settings-warning" role="alert">{{ t('wherdr is reachable from the Internet: anyone who gets in can open every file your user can read.') }}</p>
            <p class="muted settings-hint">{{ t('Previews and downloads of a path an agent writes in a conversation. wherdr runs as your user: files it cannot read stay closed, and a symlink counts where it leads.') }}</p>
            <label class="settings-toggle">
              <span><b>{{ t('Also show protected files') }}</b><small>{{ t('SSH keys, wherdr’s own data and settings, ~/.config/herdr. Off by default.') }}</small></span>
              <USwitch v-model="chatFilesProtected" size="xl" />
            </label>
          </div>
          <div data-ui-target="security.passkey" class="settings-group">
            <h3>{{ tl('Passkey · optional', 'Passkey · facultative') }}</h3>
            <PasskeyCard />
          </div>
          <div v-if="sec?.enabled" class="settings-group">
            <h3>{{ t('Ask for the passkey again after') }}</h3>
            <URadioGroup v-model="maxSession" :items="maxSessionItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
            <p class="muted settings-hint">{{ t('Counted from the last passkey unlock, used or not, for every device. Never in the middle of use: at the next opening of the app.') }}</p>
            <p v-if="deadlineText" class="muted settings-hint">{{ deadlineText }}</p>
          </div>
        </div>

        <div v-if="desk && !coarse" v-show="activeSection === 'shortcuts'" class="settings-section">
          <ShortcutsReference editable />
        </div>

        <div v-show="activeSection === 'about'" class="settings-section">
          <div class="settings-group">
            <h3>{{ t('Application') }}</h3>
            <p class="settings-version">wherdr {{ appVersion }} · herdr-core</p>
            <button type="button" class="settings-action solo" @click="reloadApp"><UIcon name="i-lucide-refresh-cw" />{{ t('Reload app') }}</button>
          </div>
        </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
function reloadApp() { applyNewVersion() }
</script>
