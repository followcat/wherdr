<script setup lang="ts">
import type { SessionInfo } from '#shared/types'
import { waitingOutsideSession } from '~/utils/sessionTabs'

type SessionMenuItem = {
  label?: string
  type?: 'checkbox' | 'separator' | 'link'
  checked?: boolean
  sessionKey?: string
  status?: SessionInfo['status']
  terminals?: number
  waiting?: number
  icon?: string
  slot?: string
  to?: string
  class?: string
  onSelect?: (e: Event) => void
}

const appVersion = useRuntimeConfig().public.version
const current = computed(() => sessionTabs.value.find(tab => tab.key === sessionTabPick.value) ?? sessionTabs.value[0])
const waiting = computed(() => waitingOutsideSession(sessionTabs.value, current.value?.key ?? ''))
const waitingLabel = computed(() => tl(`${waiting.value} waiting in other sessions`))
const aboutLabel = computed(() => tl(`wherdr ${appVersion} · About`))
const switchLabel = computed(() => {
  const name = current.value?.name || ''
  return waiting.value
    ? tl(`Session: ${name} — ${waiting.value} waiting in other sessions`)
    : tl(`Session: ${name}`)
})

const items = computed<SessionMenuItem[][]>(() => [
  sessionTabs.value.map(tab => ({
    label: tab.name,
    type: 'checkbox' as const,
    checked: tab.key === sessionTabPick.value,
    sessionKey: tab.key,
    status: tab.status,
    terminals: tab.terminals,
    waiting: tab.count,
    onSelect: () => pickSessionTab(tab.key),
  })),
  [
    {
      label: aboutLabel.value,
      icon: 'i-lucide-info',
      slot: 'session-about',
      to: '/settings?section=about',
      class: 'session-about-item',
    },
  ],
])
</script>

<template>
  <UDropdownMenu
    v-if="sessionTabs.length > 1 && current"
    :items="items"
    :content="{ align: 'start', sideOffset: 6, collisionPadding: 8 }"
    :ui="{ content: 'hw-dropdown session-switcher-menu' }"
  >
    <button type="button" class="session-switch" :aria-label="switchLabel" :title="waiting ? waitingLabel : current.name">
      <i class="session-switch-mark" aria-hidden="true" />
      <span class="session-switch-name">{{ current.name }}</span>
      <UIcon name="i-lucide-chevron-down" class="session-switch-chevron" aria-hidden="true" />
      <span v-if="waiting" class="session-switch-waiting" :aria-label="waitingLabel" :title="waitingLabel">+{{ waiting }}</span>
    </button>

    <template #item-leading="{ item }">
      <i v-if="item.status" class="session-menu-state" :class="item.status" aria-hidden="true" />
    </template>
    <template #item-label="{ item }">
      <span class="session-menu-name">{{ item.label }}</span>
      <span v-if="item.terminals !== undefined" class="sr-only">{{ item.terminals }} {{ t('terminals') }}</span>
      <span v-if="item.waiting" class="sr-only">, {{ item.waiting }} {{ t('waiting') }}</span>
    </template>
    <template #item-trailing="{ item }">
      <span v-if="item.terminals !== undefined" class="session-menu-count" aria-hidden="true">{{ item.terminals }}</span>
      <span v-if="item.waiting" class="session-menu-waiting" aria-hidden="true">{{ item.waiting }}</span>
    </template>
  </UDropdownMenu>
</template>
