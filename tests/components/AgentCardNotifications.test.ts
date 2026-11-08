import { afterEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AgentCard from '~/components/AgentCard.vue'
import { desk, coarse, herdrState } from '~/composables/useHerdr'
import { notificationRules } from '~/composables/useNotificationRules'
import { menuState } from '~/composables/useUi'
import { defaultNotifications } from '#shared/notificationRules'
import type { Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'blocked', title: 'Example agent', cwd: '/tmp/demo', agentSession: null }
afterEach(() => {
  menuState.open = false
  notificationRules.value = defaultNotifications()
  herdrState.value = { ok: false, panes: [], workspaces: [] }
  desk.value = false
  coarse.value = false
})

for (const desktop of [false, true]) {
    it(`${desktop ? 'desktop' : 'phone'} menu exposes mute state without changing the row`, async () => {
      desk.value = desktop
      coarse.value = !desktop
      herdrState.value = { ok: true, panes: [pane], workspaces: [] }
      notificationRules.value = { version: 2, default: { events: ['needs-you', 'finished'], subagents: false }, exceptions: [] }
      const w = await mountSuspended(AgentCard, { props: { pane } })
      try {
        const before = w.find('.card').html()
        const open = async () => {
          if (desktop) {
            await nextTick()
            const groups = w.findComponent({ name: 'UContextMenu' }).props('items')
            const first = groups.flat()[0]
            menuState.items = [{ label: first.label, run: first.onSelect }]
            menuState.open = true
          } else {
            // The 700 ms long press on fake timers: real ones cost 2 s per run.
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
            try {
              await w.find('.card').trigger('pointerdown', { pointerType: 'touch', button: 0, clientX: 0, clientY: 0 })
              vi.advanceTimersByTime(720)
              await w.find('.card').trigger('pointerup')
              vi.runOnlyPendingTimers()
            } finally { vi.useRealTimers() }
          }
        }
        await open()
        expect(menuState.open).toBe(true)
        expect(menuState.items[0]?.label).toBe('Mute notifications')
        if (!desktop) expect(menuState.items.filter(i => /notification/i.test(i.label ?? ''))).toHaveLength(1)
        menuState.items[0]!.run!()
        menuState.items.find(i => i.label === 'Muted')!.run!()
        await open()
        expect(menuState.items[0]?.label).toBe('Unmute notifications')
        expect(w.find('.card').html()).toBe(before)
        expect(w.find('[class*="bell"]').exists()).toBe(false)
        menuState.items[0]!.run!()
        menuState.items.find(i => i.label === 'Needs you + finished')!.run!()
        await open()
        expect(menuState.items[0]?.label).toBe('Mute notifications')
      } finally { w.unmount() }
    })
}
