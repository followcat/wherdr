import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DOMWrapper, flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError, readBody } from 'h3'
import { defineComponent, h, nextTick, ref } from 'vue'
import { UApp } from '#components'
import Composer from '~/components/Composer.vue'
import { eventsOpen } from '~/composables/useHerdr'
import { outboxFor } from '~/composables/useOutbox'
import type { Pane } from '#shared/types'

// An agent kind without a model picker: the test stays on the field and the send button.
const pane = (id: string, status: Pane['status'] = 'idle'): Pane => ({
  id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'pi', name: null, label: null, status, title: null, cwd: '/home/user/demo', agentSession: null,
})

// Each send waits for its release(), in order.
const pending: (() => void)[] = []
const release = () => pending.shift()?.()
// The next send once it reached the server (sends of a conversation go one after the other).
const releaseNext = async () => { await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0)); release() }
const prompts: string[] = []
// Bubbles of a conversation the server has not answered yet.
const sendingIn = (paneId: string) => outboxFor(paneId).filter(q => q.state === 'sending')
registerEndpoint('/api/prompt', {
  method: 'POST',
  handler: async (event) => {
    const { promise, resolve } = Promise.withResolvers<{ ok: boolean }>()
    pending.push(() => resolve({ ok: true }))
    prompts.push((await readBody<{ text: string }>(event)).text)
    return promise
  },
})
// A shell's input: answered only when the test says, or refused.
let releaseInput: (ok: boolean) => void = () => {}
const inputs: string[] = []
registerEndpoint('/api/input', {
  method: 'POST',
  handler: async (event) => {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    releaseInput = resolve
    inputs.push((await readBody<{ text: string }>(event)).text)
    if (!(await promise)) throw createError({ statusCode: 500, statusMessage: 'refused' })
    return { ok: true }
  },
})
const interrupts: string[] = []
registerEndpoint('/api/interrupt', {
  method: 'POST',
  handler: async (event) => {
    interrupts.push((await readBody<{ pane_id: string }>(event)).pane_id)
    return { stopped: true, background: 0 }
  },
})

async function mount(id: string) {
  const w = await mountSuspended(Composer, { props: { pane: pane(id), paneId: id, sendKeys: async () => {} } })
  const field = w.find('textarea')
  await field.setValue('Fix the cache')
  return { w, field }
}

describe('Composer send', () => {
  beforeEach(() => { eventsOpen.value = true })
  afterEach(() => { eventsOpen.value = false })

  it('offers View terminal only while the terminal is not on screen', async () => {
    const p: Pane = { ...pane('w3:p7'), agent: 'codex', codexField: 'left over' }
    const termShown = ref(false)
    let shown = 0
    const Host = defineComponent({ render: () => h(UApp, null, () => h(Composer, { pane: p, paneId: p.id, sendKeys: async () => {}, termShown: termShown.value, onShowTerminal: () => { shown++ } })) })
    const w = await mountSuspended(Host)
    const view = () => w.findAll('.codex-field button').filter(b => b.text() === 'View terminal')
    expect(view()).toHaveLength(1)
    await view()[0]!.trigger('click')
    expect(shown).toBe(1)
    termShown.value = true
    await nextTick()
    expect(view()).toHaveLength(0)
    expect(w.find('.codex-field').exists()).toBe(true)
    w.unmount()
  })

  it('shows text left in Codex’s field and clears it with Ctrl+U / Backspace', async () => {
    const keys: string[][] = []
    const p = ref<Pane>({ ...pane('w3:p8'), agent: 'codex', codexField: '[<65;76;23M' })
    const Host = defineComponent({ render: () => h(UApp, null, () => h(Composer, { pane: p.value, paneId: p.value.id, sendKeys: async (k: string[]) => { keys.push(k) } })) })
    const w = await mountSuspended(Host)
    const notice = w.find('.codex-field')
    expect(notice.find('code').text()).toBe('[<65;76;23M')
    await notice.find('button').trigger('click')
    await flushPromises()
    expect(keys).toHaveLength(1)
    expect(new Set(keys[0])).toEqual(new Set(['ctrl+u', 'backspace']))
    p.value = { ...p.value, codexField: undefined }
    await nextTick()
    expect(w.find('.codex-field').exists()).toBe(false)
    w.unmount()
  })

  it('empties the field and shows the message as sending before the server answers', async () => {
    const { w, field } = await mount('w1:p1')
    await w.find('button.prompt-send').trigger('click')
    expect((field.element as HTMLTextAreaElement).value).toBe('')
    expect(outboxFor('w1:p1')).toMatchObject([{ text: 'Fix the cache', state: 'sending' }])
    release()
    await flushPromises()
    await vi.waitFor(() => expect(sendingIn('w1:p1')).toHaveLength(0))
    // herdr-core keeps no record of it: the bubble stays, sent, until the transcript has it (utils/outbox.ts).
    expect(outboxFor('w1:p1')).toMatchObject([{ text: 'Fix the cache' }])
    w.unmount()
  })

  it('a lone "!" is nothing to send: no Send, and Enter neither sends nor stops', async () => {
    prompts.length = 0
    interrupts.length = 0
    const w = await mountSuspended(Composer, { props: { pane: pane('w1:b1', 'working'), paneId: 'w1:b1', sendKeys: async () => {} } })
    const field = w.find('textarea')
    await field.setValue('!')
    expect(w.find('button.prompt-send').attributes('disabled')).toBeDefined()
    await field.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(outboxFor('w1:b1')).toHaveLength(0)
    expect(prompts).toEqual([])
    expect(interrupts).toEqual([])
    expect((field.element as HTMLTextAreaElement).value).toBe('!')
    w.unmount()
  })

  it('keeps paragraph spacing in the outgoing message', async () => {
    const { w, field } = await mount('w1:p3')
    const text = 'First paragraph.\n\nSecond paragraph.\n\n\nThird paragraph.'
    await field.setValue(text)
    await w.find('button.prompt-send').trigger('click')
    expect(outboxFor('w1:p3')).toMatchObject([{ text, state: 'sending' }])
    release()
    await flushPromises()
    await vi.waitFor(() => expect(sendingIn('w1:p3')).toHaveLength(0))
    w.unmount()
  })

  it('offline: keeps the draft and sends nothing', async () => {
    eventsOpen.value = false
    const { w, field } = await mount('w1:p2')
    expect(w.find('button.prompt-send').attributes('disabled')).toBeDefined()
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    expect((field.element as HTMLTextAreaElement).value).toBe('Fix the cache')
    expect(outboxFor('w1:p2')).toHaveLength(0)
    w.unmount()
  })
})

// A dictation app pastes the text and presses Enter; while the page lags it
// can do it again before the first send is answered: one message, not two.
describe('Composer: no duplicate sends', () => {
  beforeEach(() => { eventsOpen.value = true; prompts.length = 0; inputs.length = 0; interrupts.length = 0 })
  afterEach(() => { eventsOpen.value = false })
  const enter = (field: DOMWrapper<Element>) => field.trigger('keydown', { key: 'Enter' })

  it('two fast Enters with the same text during a slow send make one bubble', async () => {
    const { w, field } = await mount('w1:d1')
    await enter(field)
    expect((field.element as HTMLTextAreaElement).value).toBe('')
    // The same text lands again, Enter again, the first send still going.
    await field.setValue('Fix the cache')
    await enter(field)
    expect((field.element as HTMLTextAreaElement).value).toBe('')
    expect(outboxFor('w1:d1')).toHaveLength(1)
    release()
    await flushPromises()
    await vi.waitFor(() => expect(sendingIn('w1:d1')).toHaveLength(0))
    expect(prompts).toEqual(['Fix the cache'])
    w.unmount()
  })

  it('a different text right after still sends', async () => {
    const { w, field } = await mount('w1:d2')
    await enter(field)
    await field.setValue('Fix the cache too')
    await enter(field)
    expect(outboxFor('w1:d2').map(q => q.text)).toEqual(['Fix the cache', 'Fix the cache too'])
    await releaseNext()
    await releaseNext()
    await vi.waitFor(() => expect(sendingIn('w1:d2')).toHaveLength(0))
    w.unmount()
  })

  it('the same text sent again later goes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { w, field } = await mount('w1:d3')
      await enter(field)
      await releaseNext()
      await vi.waitFor(() => expect(sendingIn('w1:d3')).toHaveLength(0))
      vi.setSystemTime(Date.now() + 3500)
      await field.setValue('Fix the cache')
      await enter(field)
      expect(sendingIn('w1:d3')).toHaveLength(1)
      await releaseNext()
      await vi.waitFor(() => expect(prompts).toEqual(['Fix the cache', 'Fix the cache']))
      w.unmount()
    } finally { vi.useRealTimers() }
  })

  it('a shell command empties the field before the server answers, and comes back if refused', async () => {
    const p: Pane = { ...pane('w1:d4'), agent: null }
    const w = await mountSuspended(Composer, { props: { pane: p, paneId: p.id, sendKeys: async () => {} } })
    const field = w.find('textarea')
    await field.setValue('ls -la')
    await enter(field)
    expect((field.element as HTMLTextAreaElement).value).toBe('')
    await enter(field)
    await vi.waitFor(() => expect(inputs).toEqual(['ls -la']))
    releaseInput(false)
    await flushPromises()
    await vi.waitFor(() => expect((field.element as HTMLTextAreaElement).value).toBe('ls -la'))
    // Refused: the same text may go again at once.
    await enter(field)
    await vi.waitFor(() => expect(inputs).toEqual(['ls -la', 'ls -la']))
    releaseInput(true)
    await flushPromises()
    expect((field.element as HTMLTextAreaElement).value).toBe('')
    w.unmount()
  })
})

// One stray Escape (a dictation app closing its popup) must not stop the agent.
describe('Composer: Escape stops on the second press', () => {
  beforeEach(() => { eventsOpen.value = true; interrupts.length = 0 })
  afterEach(() => { eventsOpen.value = false; vi.useRealTimers() })

  async function working(id: string) {
    const w = await mountSuspended(Composer, { props: { pane: pane(id, 'working'), paneId: id, sendKeys: async () => {}, escStops: true } })
    return { w, stop: () => (w.vm as unknown as { stop: () => boolean }).stop() }
  }

  it('one Escape only arms, a second one within the delay stops', async () => {
    const { w, stop } = await working('w1:e1')
    expect(stop()).toBe(true)
    await flushPromises()
    expect(interrupts).toEqual([])
    expect(stop()).toBe(true)
    await vi.waitFor(() => expect(interrupts).toEqual(['w1:e1']))
    w.unmount()
  })

  it('a second Escape after the delay arms again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { w, stop } = await working('w1:e2')
    stop()
    vi.setSystemTime(Date.now() + 2000)
    stop()
    await flushPromises()
    expect(interrupts).toEqual([])
    w.unmount()
  })

  it('the Stop button still stops on one click', async () => {
    const { w } = await working('w1:e3')
    await w.find('button.prompt-send').trigger('click')
    await vi.waitFor(() => expect(interrupts).toEqual(['w1:e3']))
    w.unmount()
  })
})

// References in the field (shared/reference.ts): the text is the only state.
describe('Composer references', () => {
  beforeEach(() => { eventsOpen.value = true })
  afterEach(() => { eventsOpen.value = false })
  const REF = '↳ Quote point 11:37 : Shall I merge the branch now? —'

  it('draws a reference line as a token behind the field, with a chip to remove it', async () => {
    const { w, field } = await mount('w2:p1')
    await field.setValue(`${REF}\nYes\n> typed by hand`)
    await flushPromises()
    expect(w.findAll('.qm-mirror .qm-q').map(q => q.text())).toEqual([REF])
    expect(w.findAll('.composer-quote').map(q => q.text())).toEqual(['Shall I merge the branch now?'])
    await w.find('.composer-quote-x').trigger('click')
    expect((field.element as HTMLTextAreaElement).value).toBe('Yes\n> typed by hand')
    await flushPromises()
    // Nothing left to draw: the plain field, and a ">" line starts nothing.
    expect(w.find('.qm-mirror').exists()).toBe(false)
    expect(w.findAll('.composer-quote')).toHaveLength(0)
    w.unmount()
  })

  it('sends the text of the field as it is, references included', async () => {
    const { w, field } = await mount('w2:p2')
    await field.setValue(`${REF}\nYes`)
    await w.find('button.prompt-send').trigger('click')
    expect(outboxFor('w2:p2')).toMatchObject([{ text: `${REF}\nYes` }])
    release()
    await flushPromises()
    w.unmount()
  })

  it('keeps a pasted line that reads as a reference plain text', async () => {
    const { w, field } = await mount('w2:p3')
    await field.setValue('')
    const el = field.element as HTMLTextAreaElement
    const paste = (text: string) => {
      const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
      e.clipboardData = { items: [], getData: () => text }
      el.dispatchEvent(e)
      return e.defaultPrevented
    }
    // Ordinary dictation is captured before the clipboard can change.
    expect(paste('plain words')).toBe(true)
    expect(el.value).toBe('plain words')
    await field.setValue('')
    expect(paste(`From the log:\n${REF}\nGo ahead.`)).toBe(true)
    await flushPromises()
    expect(el.value).toBe(`From the log:\n\\${REF}\nGo ahead.`)
    expect(w.find('.qm-mirror').exists()).toBe(false)
    expect(w.findAll('.composer-quote')).toHaveLength(0)
    w.unmount()
  })
})




describe('Composer paste event handling', () => {
  it.each([
    ['<p>Bonjour</p><p>le monde</p>', 'Bonjour\n\nle monde'],
    ['Bonjour<br>le monde', 'Bonjour\nle monde'],
    ['<div>Bonjour</div><div>le <b>monde</b></div>', 'Bonjour\nle monde'],
    ['<p>Bonjour</p>\n<p>le monde</p>', 'Bonjour\n\nle monde'],
    ['Bonjour<br><br><br>le monde', 'Bonjour\n\n\nle monde'],
    ['<pre>Bonjour\n  le monde</pre>', 'Bonjour\n  le monde'],
    ['<table><tr><td>Bonjour</td><td>le monde</td></tr></table>', 'Bonjour\nle monde'],
    ['Bonjour<hr><aside>le monde</aside>', 'Bonjour\nle monde'],
  ])('preserves HTML paste separators: %s', async (html, expected) => {
    const { w, field } = await mount('html-separators')
    await field.setValue('')
    let clipboard = html
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [], getData: (type: string) => type === 'text/html' ? clipboard : '' } })
    field.element.dispatchEvent(event)
    clipboard = ''
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect((field.element as HTMLTextAreaElement).value).toBe(expected)
    w.unmount()
  })

  it('handles event text, selection, HTML and beforeinput synchronously', async () => {
    const { w, field } = await mount('dictation')
    const el = field.element as HTMLTextAreaElement
    await field.setValue('Before replace after')
    el.setSelectionRange(7, 14)
    let clipboard = 'Event words'
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [], types: ['text/plain'], getData: (type: string) => type === 'text/plain' ? clipboard : '' } })
    el.dispatchEvent(event)
    clipboard = 'Old clipboard'
    await flushPromises()
    expect(el.value).toBe('Before Event words after')
    expect(event.defaultPrevented).toBe(true)
    await field.setValue('')
    const html = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(html, 'clipboardData', { value: { items: [], getData: (type: string) => type === 'text/html' ? '<b>HTML words</b>' : '' } })
    el.dispatchEvent(html)
    await flushPromises()
    expect(el.value).toBe('HTML words')
    await field.setValue('')
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: 'Input words', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(el.value).toBe('Input words')
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: 'Native edit', bubbles: true, cancelable: false }))
    expect(el.value).toBe('Input words') // The browser owns non-cancellable edits.
    w.unmount()
  })
})
