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

// `cipher` must default to undefined, not false: Vue casts a missing Boolean
// prop to false, which would switch the encrypted text off everywhere.
const props = withDefaults(defineProps<{ html: string, typing: number | null, speed?: TypingSpeed, cipher?: boolean }>(), { speed: undefined, cipher: undefined })
const emit = defineEmits<{ done: [] }>()
const el = ref<HTMLElement | null>(null)

let plan: RevealPlan | null = null
let raf = 0
const atomic = (n: RevealNode) => (n as unknown as Element).classList?.contains('code-head')
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
// An image of the reply that cannot show (refused by the security policy,
// unreachable): a note with a link instead of a broken icon (utils/imageFallback.ts).
watchImageViolations()
function onImageError(e: Event) {
  if (e.target instanceof HTMLImageElement) showImageFallback(e.target)
}
function onClick() {
  if (plan) {
    stop()
    emit('done')
  }
}

// First state applied before display: no flash of the full text.
onMounted(() => { if (props.typing !== null) start(props.typing) })
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
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  dropBands()
  plan = null
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitized by DOMPurify (utils/markdown.ts) -->
  <div ref="el" class="md-body" :class="{ typing: typing !== null }" @click.capture="onClick" @error.capture="onImageError" v-html="html" />
</template>
