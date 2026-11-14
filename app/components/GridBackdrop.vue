<script setup lang="ts">
// The website's background (website/app/components/GridBackground.vue, variant 5,
// same values): a faint 64 px grid with dots at the crossings, a soft vignette, and
// now and then a short glowing packet running along a line, at most three at once.
// Shown in the margins of the conversation on a computer when Settings › Appearance ›
// Desktop › Background is "wherdr grid" (the default). Cheap: a static CSS layer that does not scroll with the
// content; packets are Web Animations started by a timer that only runs while the
// layer is on screen and the page is visible. prefers-reduced-motion or Settings ›
// Appearance › "Animated packets" off: no packets.
import { MAX_PACKETS, nextPacketDelay, planPacket } from '~/utils/backdrop'

const root = ref<HTMLElement | null>(null)
const packets = ref<HTMLElement | null>(null)
const visible = ref(false)

let io: IntersectionObserver | undefined
let reduced = false
let live = 0
let timer: ReturnType<typeof setTimeout> | undefined

function spawn() {
  const box = packets.value
  if (!box || live >= MAX_PACKETS) return
  const p = planPacket(box.clientWidth, box.clientHeight)
  const el = document.createElement('i')
  el.className = `pkt ${p.vertical ? 'v' : 'h'}${p.reverse ? ' rev' : ''}${p.alt ? ' alt' : ''}`
  el.style.left = `${p.left}px`
  el.style.top = `${p.top}px`
  const axis = p.vertical ? 'Y' : 'X'
  box.appendChild(el)
  live++
  const anim = el.animate(
    [
      { transform: `translate${axis}(${p.reverse ? p.dist : 0}px)`, opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { opacity: 1, offset: 0.7 },
      { transform: `translate${axis}(${p.reverse ? 0 : p.dist}px)`, opacity: 0 },
    ],
    { duration: p.duration, easing: 'cubic-bezier(.4, 0, .6, 1)' },
  )
  anim.onfinish = () => { el.remove(); live-- }
}

function schedule() {
  clearTimeout(timer)
  if (reduced || !backdropPackets.value || !visible.value || document.hidden) return
  timer = setTimeout(() => { spawn(); schedule() }, nextPacketDelay())
}

watch([visible, backdropPackets], schedule)

onMounted(() => {
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  document.addEventListener('visibilitychange', schedule)
  if (root.value) {
    io = new IntersectionObserver(([e]) => { visible.value = !!e?.isIntersecting })
    io.observe(root.value)
  }
})
onBeforeUnmount(() => {
  io?.disconnect()
  document.removeEventListener('visibilitychange', schedule)
  clearTimeout(timer)
})
</script>

<template>
  <div ref="root" class="grid-backdrop" aria-hidden="true">
    <div class="gbd-dots" />
    <div ref="packets" class="gbd-packets" />
    <div class="gbd-vignette" />
  </div>
</template>

<style scoped>
/* Behind the content of its (isolated) parent: see .hw-backdrop-host in main.css. */
.grid-backdrop { position: absolute; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; contain: strict; }
.gbd-dots {
  position: absolute; inset: 0;
  background-image:
    radial-gradient(circle at 32px 32px, color-mix(in srgb, var(--muted) 60%, transparent) 1.4px, transparent 2.2px),
    linear-gradient(color-mix(in srgb, var(--line) 30%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--line) 30%, transparent) 1px, transparent 1px),
    radial-gradient(ellipse 50% 40% at 50% 25%, color-mix(in srgb, var(--accent) 6%, transparent), transparent 75%);
  background-size: 64px 64px, 64px 64px, 64px 64px, 100% 100%;
  /* Dot tiles shifted half a cell: their centres land on the line crossings. */
  background-position: calc(50% - 32px) -32px, center top, center top, 0 0;
  -webkit-mask: radial-gradient(ellipse 85% 75% at 50% 35%, #000 25%, rgba(0, 0, 0, .45) 60%, transparent 88%);
  mask: radial-gradient(ellipse 85% 75% at 50% 35%, #000 25%, rgba(0, 0, 0, .45) 60%, transparent 88%);
}
.gbd-packets {
  position: absolute; inset: 0;
  -webkit-mask: radial-gradient(ellipse 70% 60% at 50% 30%, #000 30%, transparent 75%);
  mask: radial-gradient(ellipse 70% 60% at 50% 30%, #000 30%, transparent 75%);
}
/* A small glowing head with a fading 1 px trail on the line. */
.gbd-packets :deep(.pkt) { position: absolute; display: block; will-change: transform, opacity; --c: var(--accent); }
.gbd-packets :deep(.pkt.alt) { --c: var(--lav); }
.gbd-packets :deep(.pkt.h) { width: 56px; height: 1px; margin-left: -56px; background: linear-gradient(90deg, transparent, var(--c)); } /* overflow-safe: .grid-backdrop clips (overflow: hidden) */
.gbd-packets :deep(.pkt.h.rev) { margin-left: 0; background: linear-gradient(270deg, transparent, var(--c)); }
.gbd-packets :deep(.pkt.h)::after { content: ''; position: absolute; right: -3px; top: -2px; width: 6px; height: 5px; background: var(--c); box-shadow: 0 0 10px var(--c); }
.gbd-packets :deep(.pkt.h.rev)::after { right: auto; left: -3px; }
.gbd-packets :deep(.pkt.v) { width: 1px; height: 56px; margin-top: -56px; background: linear-gradient(180deg, transparent, var(--c)); }
.gbd-packets :deep(.pkt.v.rev) { margin-top: 0; background: linear-gradient(0deg, transparent, var(--c)); }
.gbd-packets :deep(.pkt.v)::after { content: ''; position: absolute; left: -2px; bottom: -3px; width: 5px; height: 6px; background: var(--c); box-shadow: 0 0 10px var(--c); }
.gbd-packets :deep(.pkt.v.rev)::after { bottom: auto; top: -3px; }
/* Edges sink into the page background; the top edge fades out of the header. */
.gbd-vignette {
  position: absolute; inset: 0;
  background:
    linear-gradient(to right, var(--bg), transparent 14%, transparent 86%, var(--bg)),
    linear-gradient(to bottom, var(--bg), transparent 18%, transparent 70%, var(--bg));
}
</style>
