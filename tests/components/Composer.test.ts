import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick, ref } from 'vue'
import { UApp } from '#components'
import Composer from '~/components/Composer.vue'
import { eventsOpen, hardwareKeyboard } from '~/composables/useHerdr'
import { kbOpen } from '~/composables/useViewport'
import { outboxFor } from '~/composables/useOutbox'
import type { Pane } from '#shared/types'

// An agent kind without a model picker: the test stays on the field and the send button.
const pane = (id: string, status: Pane['status'] = 'idle'): Pane => ({
  id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'pi', name: null, label: null, status, title: null, cwd: '/home/user/demo', agentSession: null,
})

let release: () => void = () => {}
registerEndpoint('/api/prompt', {
  method: 'POST',
  handler: () => {
    const { promise, resolve } = Promise.withResolvers<{ ok: boolean }>()
    release = () => resolve({ ok: true })
    return promise
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

  it('shows the quota card and its actions only while the parent displays conversation', async () => {
    const p = { ...pane('w3:p9'), usageLimit: { resets: '11pm', automatic: true, credits: true, resetLink: true } }
    const w = await mountSuspended(Composer, { props: { pane: p, paneId: p.id, sendKeys: async () => {} } })
    expect(w.find('.usage-limit-card').exists()).toBe(false)
    await w.setProps({ conversation: true })
    expect(w.find('.usage-limit-card').exists()).toBe(true)
    expect(w.findAll('.usage-limit-card button, .usage-limit-card a')).toHaveLength(3)
    await w.setProps({ conversation: false })
    expect(w.find('.usage-limit-card').exists()).toBe(false)
    expect(w.findAll('.usage-limit-card button, .usage-limit-card a')).toHaveLength(0)
    w.unmount()
  })

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
    await vi.waitFor(() => expect(outboxFor('w1:p1')).toHaveLength(0))
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
    await vi.waitFor(() => expect(outboxFor('w1:p3')).toHaveLength(0))
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

// References in the field (shared/reference.ts): the text is the only state.
describe('Composer expansion', () => {
  afterEach(() => { kbOpen.value = false; hardwareKeyboard.value = false })

  it('collapses to one row when Android dismisses the keyboard but keeps the field focused', async () => {
    const { w, field } = await mount('w1:p6')
    await field.setValue('')
    kbOpen.value = true
    field.element.focus()
    await field.trigger('focusin')
    await nextTick()
    expect(w.find('.prompt').classes()).toContain('expanded')
    // Android drops the soft keyboard without blurring the textarea.
    kbOpen.value = false
    await nextTick()
    expect(w.find('.prompt').classes()).not.toContain('expanded')
    expect(document.activeElement).not.toBe(field.element)
    w.unmount()
  })

  it('stays expanded after the soft keyboard hides when a hardware keyboard is present', async () => {
    hardwareKeyboard.value = true
    const { w, field } = await mount('w1:p7')
    await field.setValue('')
    kbOpen.value = true
    field.element.focus()
    await field.trigger('focusin')
    await nextTick()
    kbOpen.value = false
    await nextTick()
    expect(w.find('.prompt').classes()).toContain('expanded')
    w.unmount()
  })
})

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
