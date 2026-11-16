import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import Composer from '~/components/Composer.vue'
import { eventsOpen } from '~/composables/useHerdr'
import { menuState } from '~/composables/useUi'
import type { MenuItem } from '~/composables/useUi'
import type { Pane } from '#shared/types'

const sent: { pane_id: string, text: string }[] = []
registerEndpoint('/api/prompt', {
  method: 'POST',
  handler: async (event) => {
    sent.push(await readBody<{ pane_id: string, text: string }>(event))
    return { ok: true, started: true }
  },
})

const pane = (id: string, agent: string): Pane => ({
  id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent, name: null, label: null, status: 'idle', title: null, cwd: '/home/user/acme-shop', agentSession: null,
})

const commands = () => menuState.items.filter((i: MenuItem) => i.kind === 'command')

async function openPlus(agent: string) {
  const p = pane(`w1:${agent}`, agent)
  // ModelPicker (devin and friends) is out of scope here: its tooltips need a
  // provider the bare mount does not have.
  const w = await mountSuspended(Composer, {
    props: { pane: p, paneId: p.id, sendKeys: async () => {} },
    global: { stubs: { ModelPicker: true } },
  })
  await w.find('[aria-label="Photo, file, paste, commands"]').trigger('click')
  return p
}

describe('Composer + menu: the agent’s slash commands', () => {
  beforeEach(() => { eventsOpen.value = true; sent.length = 0 })
  afterEach(() => { eventsOpen.value = false; menuState.open = false; menuState.items = [] })

  // Antigravity CLI 1.5.9: each one runs from a paste + Enter; the panels
  // (context, usage, diff, model) open the interactive terminal (see
  // core-screen-fixtures.test.ts). First mount of the file: a cold Nuxt
  // environment, hence the longer timeout.
  it('offers Antigravity’s commands after Interrupt', { timeout: 40000 }, async () => {
    await openPlus('agy')
    expect(commands().map(c => [c.cmd, c.desc])).toEqual([
      ['esc', 'Interrupt agent'],
      ['/compact', 'Summarize context'],
      ['/clear', 'New conversation'],
      ['/context', 'Context usage'],
      ['/usage', 'Plan usage'],
      ['/model', 'Change model'],
      ['/diff', 'View diff'],
    ])
  })

  // Devin CLI 3000.12.57: each runs from a paste + Enter; /shortcuts opens a
  // panel that shows the interactive terminal (see core-screen-fixtures.test.ts).
  it('offers Devin’s commands after Interrupt', async () => {
    await openPlus('devin')
    expect(commands().map(c => [c.cmd, c.desc])).toEqual([
      ['esc', 'Interrupt agent'],
      ['/compact', 'Summarize context'],
      ['/clear', 'New conversation'],
      ['/context', 'Context usage'],
      ['/usage', 'Plan usage'],
      ['/session-stats', 'Session stats'],
      ['/shortcuts', 'Keyboard shortcuts'],
    ])
  })

  it('sends a tapped command to the agent as its message', async () => {
    const p = await openPlus('agy')
    commands().find(c => c.cmd === '/context')!.run!()
    await flushPromises()
    expect(sent).toEqual([{ pane_id: p.id, text: '/context' }])
  })

  it('keeps an agent without a command list to Interrupt only', async () => {
    await openPlus('aider')
    expect(commands().map(c => c.cmd)).toEqual(['esc'])
  })
})
