import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import Composer from '~/components/Composer.vue'
import { useDraft } from '~/composables/useDraft'
import { coarse, eventsOpen, hardwareKeyboard } from '~/composables/useHerdr'
import { kbOpen } from '~/composables/useViewport'
import type { Pane } from '#shared/types'

// Focus/expansion of the phone composer (one row at rest, toolbar open while
// the field or one of its controls holds the focus). happy-dom gives real
// focus events with relatedTarget and a real document.activeElement.
const pane = (id: string): Pane => ({
  id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'pi', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: null,
})
const prompts: string[] = []
registerEndpoint('/api/prompt', {
  method: 'POST',
  handler: async (event) => { prompts.push((await readBody<{ text: string }>(event)).text); return { ok: true } },
})

const mounted: VueWrapper[] = []
async function mount(id: string) {
  const w = await mountSuspended(Composer, { props: { pane: pane(id), paneId: id, sendKeys: async () => {} }, attachTo: document.body })
  mounted.push(w)
  return { w, ta: w.find('textarea').element as HTMLTextAreaElement }
}
const expanded = (w: VueWrapper) => w.find('.prompt').classes().includes('expanded')
const plus = (w: VueWrapper) => w.find('button.prompt-plus').element as HTMLElement
// The pair a real focus move fires: focus/blur on the element (no bubble),
// focusin/focusout bubbling up to .composer.
const focus = (el: Element) => { (el as HTMLElement).focus(); el.dispatchEvent(new FocusEvent('focus')) }
const focusIn = (el: Element, relatedTarget: Element | null = null) => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget }))
const focusOut = (el: Element, relatedTarget: Element | null = null) => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget }))
const blurTo = (el: Element, relatedTarget: Element | null) => { (el as HTMLElement).blur(); el.dispatchEvent(new FocusEvent('blur', { relatedTarget })) }
const press = () => document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
const release = () => window.dispatchEvent(new Event('pointerup'))
const raf = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

describe('Composer focus', () => {
  beforeEach(() => { eventsOpen.value = true; coarse.value = true; kbOpen.value = false; hardwareKeyboard.value = false; prompts.length = 0 })
  afterEach(() => {
    for (const w of mounted.splice(0)) w.unmount()
    eventsOpen.value = false; coarse.value = false; kbOpen.value = false; hardwareKeyboard.value = false
  })

  it('follows the focus from the field to a control of the prompt, then collapses outside', async () => {
    const { w, ta } = await mount('w1:f1')
    focus(ta); focusIn(ta)
    await nextTick()
    expect(expanded(w)).toBe(true)
    // The press lands on the + button: it takes the focus, the field is out.
    const btn = plus(w)
    btn.focus()
    blurTo(ta, btn); focusOut(ta, btn); focusIn(btn, ta)
    await nextTick()
    expect(expanded(w)).toBe(true)
    expect(document.activeElement).toBe(btn)
    // Leaving the prompt entirely collapses the empty editor again.
    blurTo(btn, document.body); focusOut(btn, document.body)
    await nextTick()
    expect(expanded(w)).toBe(false)
  })

  it('an outside press blurs the field but keeps its target still until release', async () => {
    const { w, ta } = await mount('w1:f2')
    focus(ta); focusIn(ta)
    await nextTick()
    press()
    blurTo(ta, document.body); focusOut(ta, document.body)
    await nextTick()
    // While the finger is down the layout must not move (the tapped quote stays put).
    expect(expanded(w)).toBe(true)
    release()
    await raf()
    expect(expanded(w)).toBe(false)
  })

  it('a press that ends inside the prompt keeps it expanded after the pending frame', async () => {
    const { w, ta } = await mount('w1:f3')
    focus(ta); focusIn(ta)
    await nextTick()
    press()
    const btn = plus(w)
    btn.focus()
    blurTo(ta, btn); focusOut(ta, btn); focusIn(btn, ta)
    release()
    await raf()
    expect(expanded(w)).toBe(true)
  })

  it('soft keyboard closing releases a stale field focus', async () => {
    const { w, ta } = await mount('w1:f4')
    focus(ta); focusIn(ta)
    kbOpen.value = true
    await nextTick()
    kbOpen.value = false
    await nextTick()
    expect(document.activeElement).not.toBe(ta)
    expect(expanded(w)).toBe(false)
  })

  it('soft keyboard closing keeps the focus of a prompt control', async () => {
    const { w, ta } = await mount('w1:f5')
    focus(ta); focusIn(ta)
    const btn = plus(w)
    btn.focus()
    blurTo(ta, btn); focusOut(ta, btn); focusIn(btn, ta)
    await nextTick()
    kbOpen.value = true
    await nextTick()
    kbOpen.value = false
    await nextTick()
    expect(document.activeElement).toBe(btn)
    expect(expanded(w)).toBe(true)
  })

  it('a hardware keyboard keeps the field focus through a soft keyboard blip', async () => {
    hardwareKeyboard.value = true
    const { w, ta } = await mount('w1:f6')
    focus(ta); focusIn(ta)
    kbOpen.value = true
    await nextTick()
    kbOpen.value = false
    await nextTick()
    expect(document.activeElement).toBe(ta)
    expect(expanded(w)).toBe(true)
  })

  it('a desktop viewport blip does not blur an edit (fine pointer, no soft keyboard)', async () => {
    coarse.value = false
    const { w, ta } = await mount('w1:f7')
    focus(ta); focusIn(ta)
    kbOpen.value = true
    await nextTick()
    kbOpen.value = false
    await nextTick()
    expect(document.activeElement).toBe(ta)
    expect(expanded(w)).toBe(true)
  })

  it('keyboard closing during a composition releases the stale focus after the commit', async () => {
    const { w, ta } = await mount('w1:f8')
    focus(ta); focusIn(ta)
    await w.find('textarea').setValue('draft ')
    // A composition is active when the keyboard goes away: the stale-focus
    // release must wait for the commit, not cancel the candidate.
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '好' }))
    kbOpen.value = true
    await nextTick()
    kbOpen.value = false
    await nextTick()
    expect(document.activeElement).toBe(ta)
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '好' }))
    ta.value = 'draft 好'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    // The model — not the element — holds the committed candidate, once.
    expect(useDraft('w1:f8').text).toBe('draft 好')
    expect(prompts).toEqual([])
    // Settled: the close remembered during the composition releases now.
    await raf()
    expect(document.activeElement).not.toBe(ta)
    expect(prompts).toEqual([])
  })

  it('a composition end without a pending close keeps the focus', async () => {
    const { w, ta } = await mount('w1:f9')
    focus(ta); focusIn(ta)
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'x' }))
    await raf()
    expect(document.activeElement).toBe(ta)
  })
})
