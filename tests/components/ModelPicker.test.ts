import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery, readBody } from 'h3'
import { defineComponent, h } from 'vue'
import ModelPicker from '~/components/ModelPicker.vue'
import { eventsOpen, setToaster } from '~/composables/useHerdr'
import type { ModelInfo, Pane } from '#shared/types'

// A claude pane at a confirmed live input — the only state the picker opens in.
const pane = (over: Partial<Pane> = {}): Pane => ({
  id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null,
  status: 'idle', title: 'Agent', cwd: '/tmp/demo', agentSession: null, interaction: 'input',
  model: { id: 'sonnet-5', label: 'Sonnet 5', effort: null },
  ...over,
})

// The dropdown renders its items inline — only while its `open` prop is on, so
// a refused open really has no items to pick.
type Item = { label?: string, onSelect?: (e?: Event) => void, checked?: boolean, disabled?: boolean, children?: Item[][], type?: string }
const Dropdown = defineComponent({
  props: { open: { type: Boolean, default: false }, items: { type: Array, default: () => [] } },
  emits: ['update:open'],
  setup: (props, { slots, emit }) => () => h('div', {
    class: 'dd',
    // A click on the trigger row asks the parent for open like the real menu.
    onClick: (e: Event) => { if (!(e.target as HTMLElement).classList.contains('dd-item')) emit('update:open', !props.open) },
  }, [slots.default?.(),
    ...(props.open ? (props.items as Item[][]).flat(9).flatMap(i => [i, ...(i.children || []).flat(9)]).map(i =>
      h('button', {
        class: ['dd-item', { off: i.disabled, on: i.checked }],
        onClick: () => { i.onSelect?.(); emit('update:open', false) },
      }, i.label)) : [])]),
})
const pass = { template: '<div><slot /></div>' }
const mountPick = (p: Pane) => mountSuspended(ModelPicker, {
  props: { pane: p },
  global: { stubs: { UDropdownMenu: Dropdown, UTooltip: pass } },
})

const CATALOG = {
  agent: 'claude',
  options: [
    { label: 'Sonnet 5', hint: 'Everyday work' },
    { label: 'Opus 5.5', hint: 'Hardest problems' },
  ],
  at: 0,
}
const modelCalls: { path: string, query: Record<string, unknown> }[] = []
const posts: Record<string, unknown>[] = []
let modelList = CATALOG as unknown
let postModel: ModelInfo | null = { id: 'opus-5-5', label: 'Opus 5.5', effort: null }
let postError: { statusCode: number, statusMessage: string } | null = null
registerEndpoint('/api/models', {
  method: 'GET',
  handler: (event) => {
    modelCalls.push({ path: '/api/models', query: getQuery(event) })
    return modelList
  },
})
registerEndpoint('/api/model', {
  method: 'POST',
  handler: async (event) => {
    posts.push(await readBody(event))
    if (postError) {
      event.node.res.statusCode = postError.statusCode
      return { error: postError.statusMessage }
    }
    return { ok: true, model: postModel }
  },
})
let effortList: unknown = { levels: ['low', 'medium', 'high'], current: 'medium' }
registerEndpoint('/api/efforts', {
  method: 'GET',
  handler: () => effortList,
})
const effortPosts: Record<string, unknown>[] = []
registerEndpoint('/api/effort', {
  method: 'POST',
  handler: async (event) => { effortPosts.push(await readBody(event)); return { ok: true, model: { id: 'sonnet-5', label: 'Sonnet 5', effort: 'high' } } },
})

const items = (w: Awaited<ReturnType<typeof mountPick>>) => w.findAll('.dd-item')
const itemLabels = (w: Awaited<ReturnType<typeof mountPick>>) => items(w).map(b => b.text())
const toasts: string[] = []

describe('ModelPicker', () => {
  beforeEach(() => {
    eventsOpen.value = true
    toasts.length = 0
    setToaster({ clear() {}, add: (tt: { title: string }) => { toasts.push(tt.title) } } as never)
    modelCalls.length = 0
    posts.length = 0
    effortPosts.length = 0
    modelList = CATALOG
    postModel = { id: 'opus-5-5', label: 'Opus 5.5', effort: null }
    postError = null
    effortList = { levels: ['low', 'medium', 'high'], current: 'medium' }
  })
  afterEach(() => { eventsOpen.value = false })

  it('shows the pane model and opens the /model list with the current row checked', async () => {
    const w = await mountPick(pane())
    expect(w.get('.model-pick .model-name').text()).toBe('Sonnet 5')
    await w.get('.model-pick').trigger('click')
    await vi.waitFor(() => expect(modelCalls).toEqual([{ path: '/api/models', query: { pane: 'w1:p1' } }]))
    await vi.waitFor(() => expect(itemLabels(w)).toContain('Opus 5.5'))
    const on = w.findAll('.dd-item.on').map(b => b.text())
    expect(on).toEqual(['Sonnet 5'])
    w.unmount()
  })

  it('posts the picked label and shows the returned model while the state lags', async () => {
    const w = await mountPick(pane())
    await w.get('.model-pick').trigger('click')
    await vi.waitFor(() => expect(itemLabels(w)).toContain('Opus 5.5'))
    await w.findAll('.dd-item').find(b => b.text() === 'Opus 5.5')!.trigger('click')
    await vi.waitFor(() => expect(posts).toEqual([{ pane_id: 'w1:p1', label: 'Opus 5.5' }]))
    await vi.waitFor(() => expect(w.get('.model-pick .model-name').text()).toBe('Opus 5.5'))
    w.unmount()
  })

  it('refuses to open while the agent cannot take a model command', async () => {
    for (const over of [{ status: 'blocked' }, { status: 'working' },
      { prompt: { question: 'Allow?', options: [{ key: 'y', label: 'Yes' }] } },
      { draft: { text: 'half a thought', lines: 1 } },
      { codexField: 'typed text' },
      { interaction: 'native' }, { interaction: 'terminal' }, { interaction: undefined }]) {
      const w = await mountPick(pane(over as Partial<Pane>))
      await w.get('.model-pick').trigger('click')
      expect(items(w), JSON.stringify(over)).toHaveLength(0)
      expect(w.get('.model-pick').attributes('aria-disabled')).toBe('true')
      w.unmount()
    }
    expect(modelCalls).toHaveLength(0)
    await vi.waitFor(() => expect(toasts.length).toBeGreaterThan(0))
  })

  it('refuses while offline', async () => {
    eventsOpen.value = false
    const w = await mountPick(pane())
    await w.get('.model-pick').trigger('click')
    expect(items(w)).toHaveLength(0)
    expect(modelCalls).toHaveLength(0)
    w.unmount()
    eventsOpen.value = true
  })

  it('spins while the switch is in flight and toasts its refusal', async () => {
    postError = { statusCode: 500, statusMessage: 'The agent is working — change the model once it’s done.' }
    const w = await mountPick(pane())
    await w.get('.model-pick').trigger('click')
    await vi.waitFor(() => expect(itemLabels(w)).toContain('Opus 5.5'))
    await w.findAll('.dd-item').find(b => b.text() === 'Opus 5.5')!.trigger('click')
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    await vi.waitFor(() => expect(toasts.some(tt => tt.includes('working'))).toBe(true))
    // A failed switch keeps the old label.
    expect(w.get('.model-pick .model-name').text()).toBe('Sonnet 5')
    w.unmount()
  })

  it('posts a Fusion part pick with its parts object', async () => {
    modelList = {
      agent: 'devin',
      options: [
        { label: 'Fusion', hint: 'Pair', parts: [
          { key: 'lead', label: 'Lead', options: ['Opus 5.5', 'Sonnet 5'], current: 'Opus 5.5' },
          { key: 'sidekick', label: 'Sidekick', options: ['Haiku 4.5', 'Sonnet 5'], current: 'Haiku 4.5' },
        ] },
        { label: 'SWE-2', hint: null },
      ],
      at: 0,
    }
    const w = await mountPick(pane({ agent: 'devin', model: { id: 'swe-2', label: 'SWE-2', effort: null } }))
    await w.get('.model-pick').trigger('click')
    await vi.waitFor(() => expect(itemLabels(w)).toContain('Sonnet 5'))
    // The flattened stub renders each part's options — the second "Sonnet 5"
    // is the Sidekick one.
    const sonnets = w.findAll('.dd-item').filter(b => b.text() === 'Sonnet 5')
    await sonnets[sonnets.length - 1]!.trigger('click')
    await vi.waitFor(() => expect(posts).toEqual([{ pane_id: 'w1:p1', label: 'Fusion', parts: { sidekick: 'Sonnet 5' } }]))
    w.unmount()
  })

  it('lists and posts effort levels for an effort agent', async () => {
    const w = await mountPick(pane())
    await vi.waitFor(() => expect(w.find('.effort-pick').exists()).toBe(true))
    await w.get('.effort-pick').trigger('click')
    await vi.waitFor(() => expect(itemLabels(w)).toEqual(expect.arrayContaining(['low', 'medium', 'high'])))
    await w.findAll('.dd-item').find(b => b.text() === 'high')!.trigger('click')
    await vi.waitFor(() => expect(effortPosts).toEqual([{ pane_id: 'w1:p1', level: 'high' }]))
    w.unmount()
  })

  it('offers no effort button to an agent without effort levels', async () => {
    const w = await mountPick(pane({ agent: 'devin', model: { id: 'swe-2', label: 'SWE-2', effort: null } }))
    expect(w.find('.effort-pick').exists()).toBe(false)
    w.unmount()
  })
})
