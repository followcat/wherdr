<script setup lang="ts">
// Settings › Notifications: a default for everything, and exceptions to it.
import { LEVEL_EVENTS, compareEvents, exceptionLive, levelOf, sameNotificationTarget, type NotificationEvent, type NotificationException, type NotificationTarget } from '#shared/notificationRules'
useNotificationClock()
useNotificationRekey()
const rules = notificationRules
const now = notificationClock

function setDefault(patch: { events?: NotificationEvent[], subagents?: boolean }) {
  saveNotificationRules({ ...rules.value, default: { ...rules.value.default, ...patch } })
}
const defaultEvents = computed(() => rules.value.default.events)

// Exceptions: coordinators first (one each, on any machine), then by machine
// and name (ended timed mutes that left nothing are gone).
const exceptions = computed(() => rules.value.exceptions
  .filter(e => exceptionLive(e, now.value))
  .map(e => e.kind === 'coordinator'
    ? { e, machine: '', where: t('Coordinator'), name: coordinatorExceptionName(e.id) || e.label }
    : { e, machine: notificationMachineName(e.machine), where: `${notificationMachineName(e.machine)} · ${t('Conversation')}`, name: livePaneTitle(e.id) || e.label })
  .sort((a, b) => a.machine.localeCompare(b.machine) || a.name.localeCompare(b.name)))
const livePaneTitle = (id: string) => herdrState.value.panes.find(p => p.id === id)?.title || ''
const mutedUntil = (e: NotificationException) => e.until !== null && e.until > now.value ? e.until : null
const eventsOf = (e: NotificationException) => e.events ?? defaultEvents.value
function difference(e: NotificationException) {
  const base = defaultLevelLabel()
  const until = mutedUntil(e)
  if (until) return e.events === null
    ? tl(`Muted until ${fmtDateTime(until)}, then back to the default (${base})`, `Muet jusqu’au ${fmtDateTime(until)}, puis retour au défaut (${base})`)
    : tl(`Muted until ${fmtDateTime(until)}, then ${levelLabel(levelOf(e.events))}`, `Muet jusqu’au ${fmtDateTime(until)}, puis ${levelLabel(levelOf(e.events))}`)
  const c = compareEvents(eventsOf(e), defaultEvents.value)
  return c === 1 ? tl(`Louder than the default (${base})`, `Plus que le défaut (${base})`)
    : c === -1 ? tl(`Quieter than the default (${base})`, `Moins que le défaut (${base})`)
      : c === 0 ? tl(`Same as the default (${base})`, `Identique au défaut (${base})`)
        : tl(`Different from the default (${base})`, `Différent du défaut (${base})`)
}

// "Add an exception": an agent conversation, grouped by machine.
const picking = ref(false)
const candidates = computed(() => {
  const groups = new Map<string, { machine: string, name: string, items: NotificationTarget[] }>()
  // Grouped by the pane's machine (a coordinator's target has none).
  const add = (t: NotificationTarget, machine: string) => {
    if (rules.value.exceptions.some(e => exceptionLive(e, now.value) && sameNotificationTarget(e, t))) return
    const g = groups.get(machine) ?? { machine, name: notificationMachineName(machine), items: [] }
    if (!g.items.some(x => sameNotificationTarget(x, t))) g.items.push(t)
    groups.set(machine, g)
  }
  for (const p of herdrState.value.panes) if (p.agent) add(paneNotificationTarget(p), notificationSource(p).machine)
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
})
function addException(t: NotificationTarget) {
  // Start one step away from the default, so the exception does something.
  const muted = levelOf(defaultEvents.value) === 'muted'
  setException(t, { events: muted ? [...LEVEL_EVENTS.finished] : [], subagents: false, until: null })
  picking.value = false
}
function removeAll() {
  saveNotificationRules({ ...rules.value, exceptions: [] })
  toast(tl(`All exceptions removed. Everything follows the default: ${defaultLevelLabel()}`, `Exceptions retirées. Tout suit le défaut : ${defaultLevelLabel()}`))
}
</script>

<template>
  <div class="notification-rules" data-testid="notification-rules">
    <div class="settings-group notification-default" data-testid="notification-default">
      <h3>{{ t('Default (applies to everything)') }}</h3>
      <NotificationLevel :events="defaultEvents" :label="t('Default level')" @change="events => setDefault({ events })" />
      <p class="muted notification-help">{{ t('Visible conversations stay silent on every device. Push resumes after about 30 seconds away. Inactive tabs expire automatically.') }}</p>
    </div>

    <div class="settings-group notification-exceptions" data-testid="notification-exceptions">
      <h3>{{ t('Exceptions') }}</h3>
      <p v-if="!exceptions.length" class="muted">{{ t('No exceptions: everything follows the default. Add one for an agent, or use Notifications in its menu.') }}</p>
      <article v-for="{ e, where, name } in exceptions" :key="JSON.stringify([e.kind, e.machine, e.id])" class="notification-rule" data-testid="notification-exception">
        <div class="notification-rule-head">
          <small>{{ where }}</small>
          <b>{{ name }}</b>
          <small class="notification-diff">{{ difference(e) }}</small>
        </div>
        <NotificationLevel :events="eventsOf(e)" :muted="!!mutedUntil(e)" :label="tl(`Notifications: ${name}`, `Notifications : ${name}`)" @change="events => setException(e, { events, until: null })" />
        <button type="button" class="settings-action" @click="removeException(e)">
          <UIcon name="i-lucide-x" />{{ t('Remove exception') }}<small class="muted">{{ tl(`Back to the default: ${defaultLevelLabel()}`, `Retour au défaut : ${defaultLevelLabel()}`) }}</small>
        </button>
      </article>

      <button type="button" class="settings-action solo notification-add" :aria-expanded="picking" @click="picking = !picking"><UIcon name="i-lucide-plus" />{{ t('Add an exception') }}</button>
      <div v-if="picking" class="notification-picker" data-testid="notification-picker">
        <p v-if="!candidates.length" class="muted">{{ t('No agent conversation to add.') }}</p>
        <div v-for="g in candidates" :key="g.machine" class="notification-picker-group">
          <small>{{ g.name }}</small>
          <button v-for="c in g.items" :key="c.kind + c.id" type="button" class="settings-action" @click="addException(c)">
            <UIcon name="i-lucide-bot" />{{ c.label }}
          </button>
        </div>
      </div>
      <button v-if="exceptions.length" type="button" class="settings-action solo notification-reset" @click="removeAll"><UIcon name="i-lucide-rotate-ccw" />{{ t('Remove all exceptions') }}</button>
    </div>
  </div>
</template>

<style scoped>
.notification-rules .settings-toggle { gap:16px; }
.notification-rules .settings-toggle > span { flex:1; min-width:0; }
.notification-default > :deep(.notification-level) { margin-bottom:8px; }
.notification-help { font-size:12px; margin:8px 0 0; }
.notification-rule { border:1px solid var(--line); margin:12px 0; padding:14px; display:flex; flex-direction:column; gap:10px; min-width:0; }
.notification-rule-head b,.notification-rule-head small { display:block; overflow-wrap:anywhere; }
.notification-rule-head small { color:var(--muted); font:11px var(--mono); margin-bottom:4px; }
.notification-rule-head .notification-diff { font:12px var(--sans, inherit); margin:4px 0 0; }
.notification-rule .settings-action small { margin-left:auto; padding-left:8px; font-size:11px; }
.notification-add { margin-top:12px; }
.notification-picker { border:1px solid var(--line); padding:12px; margin-top:8px; display:flex; flex-direction:column; gap:12px; }
.notification-picker-group { display:flex; flex-direction:column; gap:4px; }
.notification-picker-group > small { color:var(--muted); font:11px var(--mono); }
.notification-reset { margin-top:16px; }
</style>
