<script setup lang="ts">
// Agent reply in markdown. `typing` = start time of the reveal (typewriter
// effect, utils/typewriter.ts): the final HTML is rendered as is
// then its text nodes are revealed progressively. A tap finishes it;
// so does `typing` going back to null (new message, setting turned off).
// In cipher mode, the writing and the deciphering each have their own front.
// The band between the two crosses the Markdown nodes without rewriting the HTML.
import { applyReveal, cipherSegments, finishReveal, GLYPH_MS, planReveal, revealedAt, trailGlyphs, typeDuration, typingFronts } from '~/utils/typewriter'
import type { RevealNode, RevealPlan } from '~/utils/typewriter'
import type { TypingSpeed } from '~/utils/typewriter'
import { SVG_THEME_VARS, svgPreview } from '~/utils/svgPreview'
import type { SvgColors } from '~/utils/svgPreview'
import { appRoute, isAppLink, linkedTask } from '#shared/appLinks'
import type { StatusKind } from '#shared/statusBlock'
import StatusCard from './StatusCard.vue'
import UiOpenCard from './UiOpenCard.vue'
import UiShowCard from './UiShowCard.vue'
import ActionCard from './ActionCard.vue'
import { h, render } from 'vue'

// `cipher` must default to undefined, not false: Vue casts a missing Boolean
// prop to false, which would switch the encrypted text off everywhere.
const props = withDefaults(defineProps<{ html: string, typing: number | null, speed?: TypingSpeed, cipher?: boolean }>(), { speed: undefined, cipher: undefined })
const emit = defineEmits<{ done: [] }>()
// Two roots (the task cards' teleports): a class given to this component goes on the body.
defineOptions({ inheritAttrs: false })
const el = ref<HTMLElement | null>(null)

let plan: RevealPlan | null = null
let raf = 0
// Reveal the SVG card and the choice buttons atomically so typing never rewrites their source or controls.
const atomic = (n: RevealNode) => {
  const classes = (n as unknown as Element).classList
  return Boolean(classes?.contains('code-head') || classes?.contains('svg-block') || classes?.contains('w-choices') || classes?.contains('wherdr-block'))
}
const keep = (n: RevealNode) => /^T[DH]$/.test((n as unknown as Element).tagName || '')

// The boxes only change when a front moves. The glyphs are
// renewed at a fixed rate, in the single requestAnimationFrame loop.
let bands: { box: HTMLElement, cells: HTMLElement[] }[] = []
let bandKey = ''
let glyphAt = 0
function dropBands() {
  for (const band of bands) band.box.remove()
  bands = []
  bandKey = ''
}
function drawBands(p: RevealPlan, decrypted: number, written: number, now: number) {
  const key = `${decrypted}:${written}`
  if (key !== bandKey) {
    dropBands()
    bandKey = key
    for (const segment of cipherSegments(p, decrypted, written)) {
      const text = segment.node as Text
      if (!text.parentNode) continue
      const box = document.createElement('span')
      box.className = 'tw-trail'
      box.setAttribute('aria-hidden', 'true')
      const cells: HTMLElement[] = []
      const glyphs = trailGlyphs(segment.text)
      Array.from(segment.text).forEach((c, i) => {
        if (/\s/.test(c)) return box.append(c)
        const cell = document.createElement('span')
        cell.textContent = c
        cell.setAttribute('data-g', glyphs[i]!)
        cells.push(cell)
        box.append(cell)
      })
      text.parentNode.insertBefore(box, text.nextSibling)
      bands.push({ box, cells })
    }
    bands.at(-1)?.cells.at(-1)?.classList.add('tw-front')
    glyphAt = now
  } else if (now - glyphAt >= GLYPH_MS) {
    glyphAt = now
    for (const band of bands) {
      const glyphs = trailGlyphs(band.cells.map(c => c.textContent || '').join(''))
      band.cells.forEach((c, i) => c.setAttribute('data-g', glyphs[i]!))
    }
  }
}

function stop() {
  cancelAnimationFrame(raf)
  raf = 0
  dropBands()
  if (plan) finishReveal(plan)
  plan = null
}
function start(at: number) {
  stop()
  if (!el.value) return
  plan = planReveal(el.value as unknown as RevealNode, { atomic, keep })
  const p = plan
  const speed = props.speed ?? typingSpeed.value
  const duration = typeDuration(p.total, speed)
  const encrypted = props.cipher ?? encryptedActive.value
  const step = () => {
    if (plan !== p) return
    // Fixed start time: a recreated component (slice loaded above)
    // resumes where it was.
    const elapsed = Date.now() - at
    const fronts = encrypted ? typingFronts(p.total, elapsed, speed) : null
    const written = fronts?.written ?? revealedAt(p.stops, elapsed, duration)
    const decrypted = fronts?.decrypted ?? written
    applyReveal(p, decrypted, encrypted, written)
    if (encrypted) drawBands(p, decrypted, written, performance.now())
    if (fronts?.done || (!encrypted && elapsed >= duration)) {
      stop()
      emit('done')
    } else raf = requestAnimationFrame(step)
  }
  step()
}

let themeObserver: MutationObserver | null = null
let svgPalette = ''
function revealSvgSource(img: HTMLImageElement) {
  const block = img.closest('.svg-block')
  const source = block?.querySelector<HTMLElement>('.svg-source')
  if (!source) return false
  source.hidden = false
  const toggle = block?.querySelector<HTMLButtonElement>('.svg-toggle')
  if (toggle) { toggle.disabled = true; toggle.setAttribute('aria-pressed', 'true') }
  const note = document.createElement('p')
  note.className = 'svg-note'
  note.textContent = t('SVG preview unavailable. Source shown below.')
  img.replaceWith(note)
  return true
}
function onSvgToggle(event: MouseEvent) {
  const button = (event.target as Element).closest<HTMLButtonElement>('.svg-toggle')
  if (!button || button.disabled) return
  const block = button.closest('.svg-block')
  const source = block?.querySelector<HTMLElement>('.svg-source')
  const image = block?.querySelector<HTMLImageElement>('img.svg-preview')
  if (!source || !image) return
  source.hidden = !source.hidden
  image.hidden = !source.hidden
  button.setAttribute('aria-pressed', String(!source.hidden))
  button.textContent = t(source.hidden ? 'Source' : 'Preview')
}
function syncSvgTheme(force = false) {
  const images = el.value?.querySelectorAll<HTMLImageElement>('.svg-block img.svg-preview')
  if (!images?.length) return
  const styles = getComputedStyle(document.documentElement)
  const colors: SvgColors = {}
  for (const [key, token] of Object.entries(SVG_THEME_VARS)) colors[key as keyof SvgColors] = styles.getPropertyValue(`--${token}`).trim()
  const palette = JSON.stringify(colors)
  if (!force && palette === svgPalette) return
  svgPalette = palette
  for (const img of images) {
    const source = img.closest('.svg-block')?.querySelector('pre code')?.textContent
    const src = source == null ? null : svgPreview(source, colors)
    if (src) img.src = src
    else revealSvgSource(img)
  }
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => syncSvgTheme())
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
  }
}
function onKey(e: KeyboardEvent) {
  if ((e.key !== 'Enter' && e.key !== ' ') || !(e.target instanceof HTMLImageElement) || !e.target.classList.contains('svg-preview')) return
  e.preventDefault()
  // Reuse ChatView's existing image click/lightbox delegation.
  e.target.click()
}
// An image of the reply that cannot show (refused by the security policy,
// unreachable): a note with a link instead of a broken icon (utils/imageFallback.ts).
watchImageViolations()
function onImageError(e: Event) {
  if (e.target instanceof HTMLImageElement && !revealSvgSource(e.target)) showImageFallback(e.target)
}
// An in-app address (utils/markdown.ts): the router opens it, no reload, the
// conversation's history entry kept for Back. A task's sheet opens over the
// conversation.
const router = useRouter()
function onAppLink(event: MouseEvent) {
  const href = (event.target as Element).closest('a[href]')?.getAttribute('href')
  if (!href || !isAppLink(href) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  const task = linkedTask(href)
  if (task) openTaskSheet(task)
  else router.push(appRoute(href))
}
// A `wherdr` block's task lines (utils/markdown.ts): each placeholder shows
// its live card (ChatTaskCard.vue) in place of the link it holds.
const taskSlots = shallowRef<{ to: HTMLElement, id: string }[]>([])
function fillTaskSlots() {
  const found = Array.from(el.value?.querySelectorAll<HTMLElement>('.wd-task[data-task]') ?? [])
  for (const to of found) to.replaceChildren()
  taskSlots.value = found.map(to => ({ to, id: to.dataset.task! }))
}
function onClick() {
  if (plan) {
    stop()
    emit('done')
  }
}

// Live status cards (utils/markdown.ts `status-slot`): each slot gets its own
// StatusCard, with the app's context; unmounted when the HTML is replaced.
const app = getCurrentInstance()!.appContext
let slots: HTMLElement[] = []
function dropCards() {
  for (const slot of slots) render(null, slot)
  slots = []
}
function mountCards() {
  dropCards()
  for (const slot of el.value?.querySelectorAll<HTMLElement>('.status-slot') ?? []) {
    const card = h(StatusCard, { kind: slot.dataset.statusKind as StatusKind, arg: slot.dataset.statusArg ?? '' })
    card.appContext = app
    slot.textContent = ''
    render(card, slot)
    slots.push(slot)
  }
  // An agent's `ui open` card, kept in its reply: no ×, it opens the place.
  for (const slot of el.value?.querySelectorAll<HTMLElement>('.open-slot') ?? []) {
    const card = h(UiOpenCard, { event: { type: 'ui-open', pane: '', link: slot.dataset.link ?? '', by: '' }, kept: true })
    card.appContext = app
    slot.textContent = ''
    render(card, slot)
    slots.push(slot)
  }
  // What an agent showed with `ui show`: a tap shows it again.
  for (const slot of el.value?.querySelectorAll<HTMLElement>('.show-slot') ?? []) {
    const card = h(UiShowCard, { event: { type: 'ui-show', pane: '', what: slot.dataset.what === 'shots' ? 'shots' : 'file', arg: slot.dataset.arg ?? '', by: '' }, kept: true })
    card.appContext = app
    slot.textContent = ''
    render(card, slot)
    slots.push(slot)
  }
  // An agent's `ui action` button: only the user's click runs it.
  for (const slot of el.value?.querySelectorAll<HTMLElement>('.action-slot') ?? []) {
    const card = h(ActionCard, { id: slot.dataset.action ?? '' })
    card.appContext = app
    slot.textContent = ''
    render(card, slot)
    slots.push(slot)
  }
}

// First state applied before display: no flash of the full text.
onMounted(() => {
  mountCards()
  fillTaskSlots()
  syncSvgTheme(true)
  if (props.typing !== null) start(props.typing)
})
watch(() => props.typing, (at) => {
  if (at === null) stop()
  else start(at)
})
// Text replaced (rare): the new HTML is shown in full.
watch(() => props.html, () => {
  if (!plan) return
  cancelAnimationFrame(raf)
  dropBands()
  plan = null
  emit('done')
}, { flush: 'pre' })
watch(() => props.html, () => { mountCards(); fillTaskSlots(); syncSvgTheme(true) }, { flush: 'post' })
onBeforeUnmount(() => {
  dropCards()
  themeObserver?.disconnect()
  cancelAnimationFrame(raf)
  dropBands()
  plan = null
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitized by DOMPurify (utils/markdown.ts) -->
  <div ref="el" v-bind="$attrs" class="md-body" :class="{ typing: typing !== null }" @click.capture="onClick" @click="onAppLink($event); onSvgToggle($event)" @keydown="onKey" @error.capture="onImageError" v-html="html" />
  <Teleport v-for="(s, i) in taskSlots" :key="`${i}:${s.id}`" :to="s.to">
    <ChatTaskCard :id="s.id" />
  </Teleport>
</template>

<style scoped>
.md-body :deep(.svg-block) { background: transparent; }
.md-body :deep(.wherdr-block .ui-open-card) { margin: 0; }
.md-body :deep(.wherdr-block) { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: 8px; margin: 8px 0; }
.md-body :deep(img.svg-preview) {
  display: block; width: 100%; max-width: 100%; max-height: 65dvh;
  object-fit: contain; margin: 0; padding: 12px; border: 0;
  background: transparent; cursor: zoom-in;
}
.md-body :deep(.svg-source[hidden]), .md-body :deep(img.svg-preview[hidden]) { display: none; }
.md-body :deep(img.svg-preview:focus-visible),
.md-body :deep(.svg-toggle:focus-visible) { outline: 1px solid var(--accent); outline-offset: -2px; }
.md-body :deep(.svg-toggle) {
  min-width: 64px; min-height: 44px; padding: 6px 8px; color: var(--muted);
  font: 500 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer;
}
.md-body :deep(.svg-toggle:hover) { color: var(--text); background: var(--surface-2); }
.md-body :deep(.svg-note) { margin: 0; padding: 12px 14px; color: var(--muted); font-size: 13px; }
.md-body :deep(.svg-block .code-head) { min-height: 44px; height: auto; }
.md-body :deep(.svg-block .code-copy) { min-width: 44px; min-height: 44px; }
</style>
