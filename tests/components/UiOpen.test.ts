import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { afterEach, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import { UApp } from '#components'
import { useRoute } from '#app'
import AgentView from '~/components/AgentView.vue'
import { herdrState, sidePanelRoom, uiOpenRequest, uiOpenedBy } from '~/composables/useHerdr'
import type { Pane } from '#shared/types'

// WHR-195: an agent's `ui open` from its conversation (AgentView.vue).
const pane: Pane = { id: 'w1:p7', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: null }
// Side gutters per layout (media query + selector context such as `.cell-view `)
// of each class in the app's stylesheet. happy-dom cannot compute max()/calc(),
// so the rules are compared as written.
function sideGutters(cls: string) {
  const out = new Map<string, string>()
  const own = new RegExp(`\\.${cls}(?![\\w-])`)
  postcss.parse(readFileSync('app/assets/css/main.css', 'utf8')).walkRules((rule) => {
    const media = rule.parent?.type === 'atrule' ? (rule.parent as postcss.AtRule).params : ''
    for (const sel of rule.selectors.filter(x => own.test(x) && !x.replace(own, '').match(/[+>~]\s*$/))) {
      let left = '', right = ''
      rule.walkDecls((d) => {
        if (d.prop === 'padding-left') left = d.value
        if (d.prop === 'padding-right') right = d.value
        if (d.prop === 'padding') { const v = postcss.list.space(d.value); left = v[3] ?? v[1] ?? v[0]!; right = v[1] ?? v[0]! }
      })
      if (left || right) out.set(`${media} | ${sel.replace(own, '&')}`, `${left} ${right}`)
    }
  })
  return out
}
// The conversation's messages (none by default).
let chatItems: { role: string, text: string, ts: string }[] = []
registerEndpoint('/api/chat', () => ({ available: true, token: 't', file: '/home/user/demo/t.jsonl', start: 0, items: chatItems }))

async function openFromAlfred(room: boolean, link = '#/settings') {
  sidePanelRoom.value = room
  herdrState.value = { ok: true, workspaces: [], panes: [pane] }
  const w = await mountSuspended(defineComponent({ render: () => h(UApp, null, () => h(AgentView, { paneId: pane.id })) }), { route: '/a/w1:p7', attachTo: document.body })
  expect(useRoute().fullPath).toBe('/a/w1:p7')
  uiOpenRequest.value = { type: 'ui-open', pane: pane.id, link, by: 'Alfred' }
  return w
}
afterEach(() => { chatItems = []; sidePanelRoom.value = false; uiOpenedBy.value = null; herdrState.value = { ok: false, workspaces: [], panes: [] } })

it('opens Settings in the side panel beside the conversation on a wide screen', async () => {
  const w = await openFromAlfred(true)
  try {
    await expect.poll(() => useRoute().fullPath).toBe('/a/w1:p7?section=appearance')
    expect(uiOpenedBy.value).toEqual({ by: 'Alfred', section: 'appearance' })
    expect(w.find('.ui-open-card').exists()).toBe(false)
  } finally { w.unmount() }
})

it('shows the card on a narrow screen, in a row with the message field\'s gutters', async () => {
  const w = await openFromAlfred(false)
  try {
    await expect.poll(() => w.find('.ui-open-card').exists()).toBe(true)
    expect(useRoute().fullPath).toBe('/a/w1:p7')
    const row = w.find('.ui-open-card').element.parentElement!
    const composer = w.find('.composer').element
    expect(row.classList.contains('ui-open-row')).toBe(true)
    expect(row.nextElementSibling).toBe(composer)
    expect(w.text()).toContain('Opened by Alfred')
    // Phone, desktop reading column, side-by-side cells: the composer's gutters.
    const composerGutters = sideGutters('composer')
    expect(composerGutters.size).toBe(3)
    expect(sideGutters('ui-open-row')).toEqual(composerGutters)
  } finally { w.unmount() }
})

// WHR-268: the reply's card is the one element; no second bar above the field.
it.each([true, false])('shows a place once when the reply keeps its card (wide screen: %s)', async (room) => {
  chatItems = [
    { role: 'user', text: 'Show me the board', ts: '2026-01-01T00:00:00Z' },
    { role: 'assistant', text: 'Here it is.\n\n```wherdr\nopen #/board?project=WHR\n```', ts: '2026-01-01T00:00:01Z' },
  ]
  const w = await openFromAlfred(room, '#/board?project=WHR')
  try {
    await expect.poll(() => w.findAll('.ui-open-card').length).toBe(1)
    await new Promise(r => setTimeout(r, 50))
    expect(w.findAll('.ui-open-card')).toHaveLength(1)
    expect(w.find('.ui-open-row').exists()).toBe(false)
    expect(w.text()).not.toContain('Opened by Alfred')
    expect(w.text()).toContain('Place in wherdr')
  } finally { w.unmount() }
})
