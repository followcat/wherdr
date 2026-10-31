<script setup lang="ts">
// Settings, in sections: appearance, conversation, terminal, agents,
// notifications, security (passkey), shortcuts, about.
import type { ThemeDef, ThemeGroup } from '~/utils/themes'
import type { TypingSpeed } from '~/utils/typewriter'
import { pasteJournalEnabled, pasteJournal, setPasteJournal } from '~/utils/pasteJournal'
import pkg from '../../package.json'
import { SETTINGS_SECTIONS, settingsBack } from '~/utils/settingsNav'
import type { SettingsSection } from '~/utils/settingsNav'
import { type QuietDuration, type QuietScope, quietUntil } from '#shared/quiet'
import { quietPeriodEnd } from '~/utils/quietPeriodEnd'
import { DEFAULT_MAX_SESSION_DAYS, MAX_SESSION_DAYS, type MaxSessionDays } from '#shared/sessionLimit'

const appVersion = pkg.version
const router = useRouter()
// Sections: sidebar on a computer (one section shown), iOS Settings-style
// list on the phone (a tap opens the section, Back returns to the list).
// The section lives in the URL (`?section=plugins`):
// on the phone, opening it adds a history entry, which the system Back button
// pops like the header's; on a computer, it replaces the entry.
const route = useRoute()
watch(() => [route.path, route.query.section], () => {
  if (route.query.section === 'desktop' || route.path === '/settings/desktop') {
    router.replace({ path: '/settings', query: { ...route.query, section: 'conversation' } })
  }
}, { immediate: true })
const section = computed<SettingsSection | null>(() => (SETTINGS_SECTIONS as readonly string[]).includes(String(route.query.section)) ? route.query.section as SettingsSection : null)
const sectionIcons: Record<SettingsSection, string> = {
  appearance: 'i-lucide-palette', conversation: 'i-lucide-message-square', terminal: 'i-lucide-square-terminal',
  agents: 'i-lucide-bot', plugins: 'i-lucide-puzzle', phone: 'i-lucide-smartphone', notifications: 'i-lucide-bell', security: 'i-lucide-lock', shortcuts: 'i-lucide-keyboard', advanced: 'i-lucide-bug', about: 'i-lucide-info',
}
const sectionLabels: Record<SettingsSection, string> = {
  appearance: 'Appearance', conversation: 'Conversation', terminal: 'Terminal', agents: 'Agents',
  plugins: 'Plugins', phone: 'Phone', notifications: 'Notifications', security: 'Security', shortcuts: 'Shortcuts', advanced: 'Advanced', about: 'About',
}
const sections = computed(() => SETTINGS_SECTIONS
  .filter(id => id !== 'shortcuts' || (desk.value && !coarse.value))
  .map(id => ({ id, label: t(sectionLabels[id]), icon: sectionIcons[id] })))
const activeSection = computed<SettingsSection | null>(() => {
  if (section.value && sections.value.some(s => s.id === section.value)) return section.value
  return desk.value ? 'appearance' : null
})
const activeLabel = computed(() => sections.value.find(s => s.id === activeSection.value)?.label || t('Settings'))
const body = ref<HTMLElement | null>(null)
watch(section, () => nextTick(() => { if (body.value) body.value.scrollTop = 0 }))
function openSection(id: SettingsSection) {
  if (id === section.value) return
  const to = { path: '/settings', query: { section: id } }
  if (desk.value) router.replace(to)
  else router.push(to)
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
  if (desk.value || typeof (history.state as { back?: unknown } | null)?.back === 'string') return
  const here = route.fullPath
  await router.replace('/')
  await router.push(here)
})
const lang = ref<Lang>(language)
watch(lang, (l) => {
  if (l === language) return
  setLanguage(l)
  location.reload()
})
// Global refs bound in the template: local (assignable) aliases.
const shellsOn = showShells
const countersOn = showCounters
const quotasOn = showQuotas
const homeGroup = homeGrouping
const homeGroupItems = computed(() => [{ value: 'machine', label: t('Machine') }, { value: 'state', label: t('State') }])
const compactOn = compactList
const autoReorderOn = autoReorderReady
const encryptedOn = encryptedText
const agentClipboardOn = agentClipboard
// Quoted replies: the mode of this device.
const quoteChoice = quoteMode
const quoteItems = computed(() => [
  { label: tl('Tokens, native field', 'Jetons, champ natif'), description: tl('Each “↳ … —” line is drawn as a token in the usual field. Typing, dictation and autocorrect unchanged. Default.', 'Chaque ligne « ↳ … — » est dessinée en jeton dans le champ habituel. Saisie, dictée et correction auto inchangées. Par défaut.'), value: 'native' },
  { label: tl('Plain text', 'Texte simple'), description: tl('The same “↳ … —” lines, shown as plain text. A fallback if the tokens misbehave.', 'Les mêmes lignes « ↳ … — », affichées en texte simple. Un secours si les jetons se comportent mal.'), value: 'lines' },
])
// How questions and points offer to be quoted (utils/questionReply.ts).
const replyStyleChoice = replyStyle

// Voice input: the on-device speech model (utils/asrModel.ts) lives in Cache
// Storage; the composer's microphone stays dim until `asrInstalled` is true.
const asrInstalling = ref(false)
const asrRemoving = ref(false)
const asrDlFile = ref('')
const asrDlGot = ref(0)
const asrDlTotal = ref(0)
const asrDlDone = ref(0)
const asrDlCount = ref(0)
const asrError = ref('')
function fmtMb(n: number) { return `${Math.round(n / 1048576)} MB` }
const asr = {
  installing: asrInstalling, removing: asrRemoving, error: asrError,
  dlFile: asrDlFile, dlGot: asrDlGot, dlTotal: asrDlTotal, dlDone: asrDlDone, dlCount: asrDlCount,
  async install() {
    asrInstalling.value = true; asrError.value = ''
    try {
      await installAsr((p) => { asrDlFile.value = p.file; asrDlGot.value = p.got; asrDlTotal.value = p.total; asrDlDone.value = p.done; asrDlCount.value = p.count })
    } catch (err) { asrError.value = (err as Error).message }
    finally { asrInstalling.value = false }
  },
  async remove() {
    asrRemoving.value = true
    try { await removeAsr() } finally { asrRemoving.value = false }
  },
}
onMounted(() => { refreshAsrInstalled() })
const replyStyleItems = computed(() => [
  { label: tl('Icon', 'Icône'), description: tl('A small ↳ after each question, and a grey one after each point (on hover on a computer). Default.', 'Un petit ↳ après chaque question, et un gris après chaque point (au survol sur ordinateur). Par défaut.'), value: 'icon' },
  { label: tl('Tap the text', 'Toucher le texte'), description: tl('No button: a question is underlined, tap it. A point: click it on a computer; on a phone, tap it, then “↳ Discuss”.', 'Aucun bouton : une question est soulignée, touche-la. Un point : clique-le sur ordinateur ; sur téléphone, touche-le, puis « ↳ Discuter ».'), value: 'text' },
  { label: tl('List under the message', 'Liste sous le message'), description: tl('A number after each question and the questions listed under the message; “+ Quote a point”, then the point.', 'Un numéro après chaque question et les questions listées sous le message ; « + Citer un point », puis le point.'), value: 'list' },
])
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
const widthItems = computed(() => [
  { label: t('Normal'), description: t('760 px column · terminal fitted to width.'), value: 'normal' },
  { label: t('Wide'), description: t('Up to 1100 px · terminal fitted to width.'), value: 'wide' },
  { label: t('Full width'), description: t('The whole width, terminal included.'), value: 'full' },
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
const focusBorderMode = focusBorder
const focusBorderItems = computed(() => [
  { label: t('Border only'), description: t('A second color glides slowly around the border.'), value: 'border' },
  { label: t('Halo'), description: t('The same, with a faint glow around the field.'), value: 'halo' },
  { label: t('None'), description: t('Plain 1 px border, no animation.'), value: 'off' },
])
const backdropMode = backdrop
const packetsOn = backdropPackets
const backdropItems = computed(() => [
  { label: 'wherdr grid', description: t('Dotted grid with light packets, like wherdr.dev.'), value: 'wherdr' },
  { label: 'herdr grid', description: t('Flat line grid, like herdr.dev.'), value: 'herdr' },
])
const langItems = [{ label: 'English', value: 'en' }, { label: 'Français', value: 'fr' }]

// Inventory of the reachable machines; the preferences follow the user across devices.
const agentMachines = computed(() => {
  const configured = appConfig.value.machines
  return configured?.filter(m => m.local || (Boolean(m.home) && (machineInfo(m.key)?.status === 'online' || (!machineInfo(m.key) && m.online))))
    || [{ key: '', label: hostLabel.value || t('This machine'), kinds: appConfig.value.kinds }]
})
const installedAgents = computed(() => [...new Set(agentMachines.value.flatMap(m => m.kinds || []))])
function agentChecked(kind: string) { return !hiddenAgents.value.includes(kind) }
function setAgentChecked(kind: string, checked: boolean) {
  hiddenAgents.value = checked
    ? hiddenAgents.value.filter(k => k !== kind)
    : [...hiddenAgents.value, kind]
}
function agentMachineHint(kind: string) {
  const available = agentMachines.value.filter(m => m.kinds.includes(kind))
  if (available.length === agentMachines.value.length) return ''
  return available.map(m => m.label || t('This machine')).join(', ')
}

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
// Picker section titles: brand names stay as is in both languages.
const themeGroupLabel = (g: ThemeGroup) => (g === 'agents' ? tl('Agents', 'Agents') : g === 'herdr' ? 'Herdr' : 'wherdr')
// Preview: background, surface, line, text, accent, states (working, waiting, done).
const swatches = (th: ThemeDef) => [th.c.bg, th.c.surface, th.c.line, th.c.text, th.c.accent, th.c.blue, th.c.rose, th.c.teal]
const herdrName = computed(() => {
  const h = appConfig.value.herdrTheme
  if (!h) return null
  return h.autoSwitch ? `${h.darkName || 'catppuccin'} / ${h.lightName || 'catppuccin-latte'}` : h.name || 'catppuccin'
})
const followed = computed(() => themeById(resolveHerdrTheme(appConfig.value.herdrTheme, false).id))
const themesOpen = ref(false)
const currentTheme = computed(() => (themeChoice.value === FOLLOW_HERDR ? followed.value : themeById(themeChoice.value)))
const currentLabel = computed(() => (themeChoice.value === FOLLOW_HERDR
  ? `${t('Follow Herdr')}${followed.value ? ` · ${followed.value.label}` : ''}`
  : (currentTheme.value ? currentTheme.value.label : themeChoice.value)))
function pickTheme(id: string) {
  themeChoice.value = id
  haptic()
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
    .toLocaleString(language === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return tl(`This device asks for the passkey again at the first opening after ${when}.`, `Cet appareil redemandera la clé d’accès à la première ouverture après le ${when}.`)
})

onMounted(loadUpdate)
onMounted(() => {
  refreshTerminalRenderStatus()
  loadConfig() // Herdr theme up to date for "Follow Herdr"
  refreshPush().then(refreshQuiet)
  refreshSecurity()
})
</script>

<template>
  <section id="settings" class="view settings-view">
    <header class="top bar settings-top">
      <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('Back')" @click="back" />
      <h2>{{ desk ? t('Settings') : activeLabel }}</h2>
    </header>
    <div class="settings-layout" :class="{ 'section-open': activeSection }">
      <nav class="settings-nav" :aria-label="t('Settings sections')">
        <button
          v-for="item in sections" :key="item.id" type="button" class="settings-nav-item"
          :class="{ selected: activeSection === item.id }" :aria-current="activeSection === item.id ? 'page' : undefined"
          @click="openSection(item.id)"
        >
          <UIcon :name="item.icon" /><span>{{ item.label }}</span><UIcon name="i-lucide-chevron-right" class="settings-nav-arrow" />
        </button>
      </nav>
      <div v-show="activeSection" ref="body" class="settings-body">
        <h2 class="settings-section-title">{{ activeLabel }}</h2>

        <div v-show="activeSection === 'appearance'" class="settings-section">
          <div class="settings-group">
            <h3>{{ t('Theme') }}</h3>
            <!-- Collapsed by default: the current theme shows, a tap expands the list. -->
            <button type="button" class="theme-opt theme-current" :aria-expanded="themesOpen" @click="themesOpen = !themesOpen">
              <span class="theme-sw"><i v-for="(c, i) in currentTheme ? swatches(currentTheme) : []" :key="i" :style="{ background: c }" /></span>
              <span class="theme-name">{{ currentLabel }}<small>{{ t(themesOpen ? 'Hide themes' : 'Change theme') }}</small></span>
              <UIcon :name="themesOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="theme-check" />
            </button>
            <div v-show="themesOpen" class="theme-list" role="radiogroup" :aria-label="t('Theme')">
              <section v-for="sec in themeSections()" :key="sec.group" class="theme-section" :aria-label="themeGroupLabel(sec.group)">
                <h4 class="theme-section-title">{{ themeGroupLabel(sec.group) }}</h4>
                <div class="theme-grid">
                  <button
                    v-if="sec.group === 'herdr'"
                    type="button" role="radio" class="theme-opt" :class="{ on: themeChoice === FOLLOW_HERDR }" :aria-checked="themeChoice === FOLLOW_HERDR"
                    @click="pickTheme(FOLLOW_HERDR)"
                  >
                    <span class="theme-sw">
                      <i v-for="(c, i) in followed ? swatches(followed) : []" :key="i" :style="{ background: c }" />
                    </span>
                    <span class="theme-name">{{ t('Follow Herdr') }}<small>{{ herdrName ? `config.toml · ${herdrName}` : t('config.toml not found') }}</small></span>
                    <UIcon v-if="themeChoice === FOLLOW_HERDR" name="i-lucide-check" class="theme-check" />
                  </button>
                  <button
                    v-for="th in sec.themes" :key="th.id" type="button" role="radio" class="theme-opt" :class="{ on: themeChoice === th.id }"
                    :aria-checked="themeChoice === th.id" @click="pickTheme(th.id)"
                  >
                    <span class="theme-sw"><i v-for="(c, i) in swatches(th)" :key="i" :style="{ background: c }" /></span>
                    <span class="theme-name">{{ th.label }}<small v-if="th.id === DEFAULT_THEME">{{ t('default') }}</small><small v-else-if="th.light">{{ t('light') }}</small></span>
                    <UIcon v-if="themeChoice === th.id" name="i-lucide-check" class="theme-check" />
                  </button>
                </div>
              </section>
            </div>
          </div>
          <p class="muted settings-hint">{{ t('The theme follows you on every device.') }}</p>

          <div class="settings-group">
            <h3>{{ t('Message field border on focus') }}</h3>
            <URadioGroup v-model="focusBorderMode" :items="focusBorderItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
            <p class="muted settings-hint">{{ t('Also on omp’s running actions (border only). Frozen when the system asks for reduced motion. Follows you on every device.') }}</p>
          </div>

          <div class="settings-group">
            <h3>{{ t('Language') }}</h3>
            <URadioGroup v-model="lang" :items="langItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
          </div>
          <p class="muted settings-hint">{{ t('The interface language is saved on this device.') }}</p>

          <div class="settings-group">
            <h3>{{ t('Home screen') }}</h3>
            <h4 id="home-group-label">{{ t('Group by') }}</h4>
            <URadioGroup v-model="homeGroup" :items="homeGroupItems" aria-labelledby="home-group-label" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />

            <label class="settings-toggle">
              <span><b>{{ t('Compact list') }}</b><small>{{ t('Tasks: one line in Compact, two in Normal with current activity and relevant labels. Details stay in the task sheet. Follows you on every device.') }}</small></span>
              <USwitch v-model="compactOn" color="success" size="xl" />
            </label>
            <label class="settings-toggle">
              <span><b>{{ t('Reorder automatically') }}</b><small>{{ t('In Ready, show unread agents before read ones. Follows you on every device.') }}</small></span>
              <USwitch v-model="autoReorderOn" color="success" size="xl" />
            </label>
            <label class="settings-toggle">
              <span><b>{{ t('Show terminals') }}</b><small>{{ t('Show terminal spaces in the list, filed under Ready.') }}</small></span>
              <USwitch v-model="shellsOn" color="success" size="xl" />
            </label>
            <label class="settings-toggle">
              <span><b>{{ t('Show counters') }}</b><small>{{ t('Show agent counters on the home screen.') }}</small></span>
              <USwitch v-model="countersOn" color="success" size="xl" />
            </label>
            <label class="settings-toggle">
              <span><b>{{ t('Show quotas') }}</b><small>{{ t('Show Claude and Codex quotas on the home screen.') }}</small></span>
              <USwitch v-model="quotasOn" color="success" size="xl" />
            </label>
            <MachineBarSettings />
          </div>

          <div class="settings-group">
            <h3>{{ t('Quotas') }}</h3>
            <URadioGroup v-model="quotaMode" :items="quotaItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
            <p class="muted settings-hint">{{ t('The color always flags a nearly exhausted quota. Follows you on every device.') }}</p>
          </div>

          <!-- Computer layout only (same threshold as the app: 900 px). -->
          <template v-if="desk">
            <div class="eyebrow settings-subhead"><span>{{ t('Desktop') }}</span></div>
            <div class="settings-group">
              <h3>{{ t('Background') }}</h3>
              <URadioGroup v-model="backdropMode" :items="backdropItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
              <label v-if="backdropMode === 'wherdr'" class="settings-toggle">
                <span><b>{{ t('Animated packets') }}</b><small>{{ t('Small glowing squares running along the wherdr grid.') }}</small></span>
                <USwitch v-model="packetsOn" color="success" size="xl" />
              </label>
              <p class="muted settings-hint">{{ t('In the margins of the conversation. Still when the system asks for reduced motion. Follows you on every device.') }}</p>
            </div>
            <div class="settings-group settings-width">
              <h3>{{ t('Content width') }}</h3>
              <URadioGroup v-model="width" :items="widthItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
              <p class="muted settings-hint">{{ t('Conversation, terminal, settings and other content. Saved on this device.') }}</p>
            </div>
          </template>
        </div>

        <div v-show="activeSection === 'conversation'" class="settings-section">
          <div class="settings-group">
            <h3>{{ t('Default pane view') }}</h3>
            <URadioGroup v-model="defaultPane" :items="defaultPaneItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
            <p class="muted settings-hint">{{ t('What an agent pane opens on. A pane you switched to Terminal stays there. Follows you on every device.') }}</p>
          </div>
          <div class="settings-group settings-typing">
            <h3>{{ t('Typewriter') }}</h3>
            <URadioGroup v-model="typewriter" :items="typingItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" :disabled="reducedMotion" />
            <p class="muted settings-hint">{{ t(reducedMotion ? 'Off: the system asks for reduced motion.' : 'Only new replies are animated; history appears at once. Tap a reply while it types to show it in full. Follows you on every device.') }}</p>
            <label class="settings-toggle encrypted-toggle" :class="{ 'is-disabled': !typewriterActive }">
              <span><b>{{ t('Encrypted text') }}</b><small>{{ t('Writing advances in glyphs, then the text decrypts behind it.') }}</small></span>
              <USwitch v-model="encryptedOn" :disabled="!typewriterActive" color="success" size="xl" />
            </label>
            <TypingPreview v-if="activeSection === 'conversation'" />
          </div>
          <div class="settings-group">
            <h3>{{ tl('Reply style', 'Style de réponse') }}</h3>
            <p class="muted settings-lead">{{ tl('Each question an agent asks, and each point it lists, can be quoted in the field to answer them one by one. Choose how they offer it.', 'Chaque question d’un agent, et chaque point qu’il liste, peut être cité dans le champ pour y répondre un par un. Choisis comment ils le proposent.') }}</p>
            <URadioGroup v-model="replyStyleChoice" :items="replyStyleItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio reply-style-radio" />
            <p class="muted settings-hint">{{ tl('Follows you on every device.', 'Te suit sur tous tes appareils.') }}</p>
          </div>
          <div class="settings-group">
            <h3>{{ tl('Quoted replies', 'Réponses citées') }}</h3>
            <p class="muted settings-lead">{{ tl('Answer several questions, passages or decisions of an agent in one message: each one goes into the field as a “↳ … —” line that names the message and quotes it, your answer below. Choose how the field shows these lines; the message sent is the same.', 'Réponds à plusieurs questions, passages ou décisions d’un agent dans un seul message : chacun entre dans le champ sous la forme d’une ligne « ↳ … — » qui nomme le message et le cite, ta réponse en dessous. Choisis comment le champ affiche ces lignes ; le message envoyé est le même.') }}</p>
            <QuoteTokensPreview v-if="activeSection === 'conversation'" :mode="quoteChoice" />
            <URadioGroup v-model="quoteChoice" :items="quoteItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio quote-mode-radio" />
            <p class="muted settings-hint">{{ tl('Saved on this device.', 'Enregistré sur cet appareil.') }}</p>
          </div>
          <div class="settings-group">
            <h3>{{ tl('Voice input', 'Saisie vocale') }}</h3>
            <p class="muted settings-lead">{{ tl('Dictate into the message field on this device: the speech model (about 200 MB) downloads once into the browser and stays here — recognition runs on the phone, no server or account. The microphone button in the field turns on once the model is downloaded.', 'Dicte dans le champ de message sur cet appareil : le modèle vocal (environ 200 Mo) se télécharge une fois dans le navigateur et y reste — la reconnaissance tourne sur le téléphone, sans serveur ni compte. Le bouton micro du champ s’active une fois le modèle téléchargé.') }}</p>
            <div v-if="asrInstalling" class="asr-progress">
              <progress :value="asrDlDone" :max="asrDlCount || 1" />
              <p class="muted settings-hint">{{ asrDlFile }}<template v-if="asrDlGot"> · {{ fmtMb(asrDlGot) }}<template v-if="asrDlTotal"> / {{ fmtMb(asrDlTotal) }}</template></template></p>
            </div>
            <p v-if="asrError" class="settings-hint asr-error">{{ asrError }}</p>
            <div class="settings-row">
              <UButton v-if="!asrInstalled" :loading="asrInstalling" color="primary" variant="soft" icon="i-lucide-download" @click="asr.install">{{ tl('Download the model', 'Télécharger le modèle') }}</UButton>
              <template v-else>
                <UBadge color="success" variant="soft"><UIcon name="i-lucide-check" /> {{ tl('Installed on this device', 'Installé sur cet appareil') }}</UBadge>
                <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-trash-2" :loading="asrRemoving" @click="asr.remove">{{ tl('Remove', 'Supprimer') }}</UButton>
              </template>
            </div>
            <p class="muted settings-hint">{{ tl('Kept on this device across app updates.', 'Conservé sur cet appareil entre les mises à jour de l’app.') }}</p>
          </div>
        </div>

        <div v-show="activeSection === 'terminal'" class="settings-section">
          <div class="settings-group">
            <h3>{{ t('Home screen') }}</h3>
            <label class="settings-toggle">
              <span><b>{{ t('Show terminals') }}</b><small>{{ t('Show terminal spaces in the list, filed under Ready.') }}</small></span>
              <USwitch v-model="shellsOn" color="success" size="xl" />
            </label>
          </div>
          <div class="settings-group">
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
              <USwitch v-model="agentClipboardOn" color="success" size="xl" />
            </label>
          </div>
          <div class="settings-group">
            <label class="settings-toggle">
              <span><b>{{ t('Smooth touch scrolling (beta)') }}</b><small>{{ t('Experimental finger tracking and inertia. Saved on this device.') }}</small></span>
              <USwitch v-model="smoothScrollingOn" color="success" size="xl" />
            </label>
          </div>
          <div class="settings-group settings-renderer">
            <h3>{{ t('Terminal rendering') }}</h3>
            <URadioGroup v-model="renderer" :items="rendererItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" />
            <p class="muted settings-hint">{{ t('Rendering is saved on this device.') }}</p>
            <p class="settings-renderer-status" role="status">{{ rendererStatus }}</p>
          </div>
        </div>

        <div v-show="activeSection === 'agents'" class="settings-section">
          <div class="settings-group">
            <h3>{{ t('Offered agents') }}</h3>
            <p class="muted agent-pref-intro">{{ t('Agents offered wherever an agent is chosen. Terminal is always available.') }}</p>
            <div v-if="installedAgents.length" class="agent-pref-list">
              <label v-for="agent in installedAgents" :key="agent" class="settings-toggle">
                <span><b>{{ kindLabel(agent) }}</b><small v-if="agentMachineHint(agent)">{{ agentMachineHint(agent) }}</small></span>
                <input class="agent-pref-check" type="checkbox" :checked="agentChecked(agent)" @change="setAgentChecked(agent, ($event.target as HTMLInputElement).checked)">
              </label>
            </div>
            <p v-else class="muted agent-pref-intro">{{ t('No agents installed on online machines.') }}</p>
            <p class="muted agent-pref-note">{{ t('Choices follow you on every device.') }}</p>
          </div>
          <div id="claude-quotas" class="settings-group">
            <h3>{{ tl('Claude quotas', 'Quotas Claude') }}</h3>
            <ClaudeQuotaSetup v-if="activeSection === 'agents'" />
          </div>
          <WorktreesSection />
        </div>

        <div v-show="activeSection === 'notifications'" class="settings-section">
          <div class="settings-group" data-testid="notification-quiet">
            <label class="settings-toggle quiet-toggle">
              <span><b><UIcon :name="quietOn ? 'i-lucide-bell-off' : 'i-lucide-bell'" />{{ tl('Do not disturb', 'Silence') }}</b><small>{{ tl('Turns off every notification, no exceptions: the rules below are ignored.', 'Coupe toutes les notifications, sans exception : les réglages ci-dessous sont ignorés.') }}</small></span>
              <USwitch v-model="quietOn" color="success" size="xl" />
            </label>
            <p class="notify-caption">{{ tl('Silence on', 'Couper pour') }}</p>
            <URadioGroup :model-value="quietScope" :items="quietScopeItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" @update:model-value="v => pickQuietScope(v as QuietScope)" />
            <p v-if="!subscribed" class="muted notify-hint">{{ tl('“This device” needs notifications turned on below.', '« Cet appareil » demande d’activer les notifications ci-dessous.') }}</p>
            <p class="notify-caption">{{ tl('Duration', 'Durée') }}</p>
            <URadioGroup :model-value="quietDuration" :items="quietDurationItems" variant="table" indicator="end" color="primary" size="lg" class="settings-radio" @update:model-value="v => pickQuietDuration(v as QuietDuration)" />
            <p class="muted notify-hint" :class="{ 'quiet-end': quietOn }">{{ quietEnd || tl('Notifications come back on by themselves at the end.', 'Retour automatique à la normale à la fin de la durée choisie.') }}</p>
          </div>
          <NotificationRules />
          <div class="settings-group">
            <h3>{{ tl('This device’s notifications', 'Notifications de cet appareil') }}</h3>
            <PushCard detailed />
          </div>
        </div>

        <div v-show="activeSection === 'plugins'" class="settings-section">
          <ProjectsPluginSettings :machines="appConfig.machines || [{ key: '', label: hostLabel || t('This machine'), local: true, home: '', dirs: [], online: true, kinds: [] }]" />
        </div>

        <div v-show="activeSection === 'phone'" class="settings-section">
          <PhoneSetup :active="activeSection === 'phone'" />
        </div>

        <div v-show="activeSection === 'security'" class="settings-section">
          <div class="settings-group">
            <h3>{{ tl('Network access', 'Accès réseau') }}</h3>
            <OpenNetworkBanner />
            <p v-if="!appConfig.openNetwork" class="muted settings-hint">{{ tl('wherdr only answers this computer (localhost) and your tailnet. A device on another network (a Wi-Fi, a LAN, the Internet) is refused, even with the address and the port. A proxy or tunnel you run on this computer counts as this computer.', 'wherdr ne répond qu’à cet ordinateur (localhost) et à ton tailnet. Un appareil sur un autre réseau (un Wi-Fi, un réseau local, Internet) est refusé, même avec l’adresse et le port. Un proxy ou un tunnel que tu fais tourner sur cet ordinateur compte comme cet ordinateur.') }}</p>
            <NetworkTips />
          </div>
          <div class="settings-group">
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
          <ShortcutsReference />
        </div>

        <div v-show="activeSection === 'advanced'" class="settings-section">
          <div class="settings-group">
            <h3>{{ t('Paste journal') }}</h3>
            <label class="settings-toggle">
              <span>{{ t('Paste journal') }}</span>
              <USwitch :model-value="pasteJournalEnabled" @update:model-value="setPasteJournal" />
            </label>
            <p class="muted settings-hint">{{ t('Records the last 50 paste events on this device, without text content. Turning it off clears the journal.') }}</p>
            <pre class="mono paste-journal" style="white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px">{{ JSON.stringify(pasteJournal, null, 2) }}</pre>
          </div>
        </div>

        <div v-show="activeSection === 'about'" class="settings-section">
          <div class="settings-group">
            <h3>{{ t('Application') }}</h3>
            <p class="settings-version">wherdr · v{{ appVersion }}</p>
            <UpdateBanner v-if="updateInfo?.latest" :info="updateInfo" />
            <p v-else-if="updateInfo?.checked" class="muted settings-hint">{{ t('This is the latest version.') }}</p>
            <button type="button" class="settings-action solo" @click="reloadApp"><UIcon name="i-lucide-refresh-cw" />{{ t('Reload app') }}</button>
            <button type="button" class="settings-action solo" @click="openOnboarding"><UIcon name="i-lucide-compass" />{{ tl('Setup guide', 'Guide de démarrage') }}</button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
function reloadApp() { applyNewVersion() }
</script>
