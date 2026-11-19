<script setup lang="ts">
// The theme editor's preview: a miniature of the whole app (sidebar, conversation,
// settings, terminal) drawn with the palette being edited. Made-up content, inert.
// It reuses the app's own classes (.stat, .card-state, .msg-bubble, .md-body,
// .group-title, USwitch) so that it follows the real interface, and is laid out
// at a fixed size then zoomed to the width it is given.
import type { ThemeVariant } from '~/utils/themes'

const props = defineProps<{ variant: ThemeVariant }>()
const W = 720 // the miniature's own width, before zoom
const root = ref<HTMLElement>()
const zoom = ref(0.5)
let ro: ResizeObserver | undefined
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !root.value) return
  ro = new ResizeObserver(([e]) => { if (e?.contentRect.width) zoom.value = e.contentRect.width / W })
  ro.observe(root.value)
})
onBeforeUnmount(() => ro?.disconnect())

const style = computed(() => ({ ...themeVars(props.variant), '--zoom': String(zoom.value) }))
const AGENTS = [
  { name: 'api-server', s: 'working', label: 'Working' },
  { name: 'docs-site', s: 'blocked', label: 'Your turn' },
  { name: 'mobile-app', s: 'done', label: 'Done' },
  { name: 'coordinator', s: 'idle', label: 'Ready' },
]
const STATS = [{ s: 'blocked', n: 1, label: 'Your turn' }, { s: 'working', n: 1, label: 'Working' }, { s: 'done', n: 2, label: 'Done' }]
// Terminal: one line per ANSI pair (normal, bright), each word in its color.
const TERM = [
  [['$ ', 7], ['npm test', 15]],
  [['✓', 2], [' 42 passed ', 10], ['✗', 1], [' 1 failed ', 9], ['⚠', 3], [' 2 warnings', 11]],
  [['~/project', 4], [' on ', 8], ['main', 5], [' ', 0], ['+3', 6], [' -1', 13], [' ', 0], ['v22', 12], [' ', 0], ['ok', 14]],
] as const
</script>

<template>
  <div ref="root" class="tp" :style="style" data-testid="theme-preview" inert aria-hidden="true">
    <div class="tp-app">
      <aside class="tp-side">
        <div class="tp-brand"><AppLogo /><b>wherdr</b></div>
        <div class="stats">
          <div v-for="c in STATS" :key="c.s" class="stat" :class="c.s"><b>{{ c.n }}</b><span><i />{{ tl(c.label) }}</span></div>
        </div>
        <h5 class="group-title">{{ tl('Agents') }} <span class="count">4</span></h5>
        <div v-for="a in AGENTS" :key="a.name" class="tp-row" :class="{ on: a.s === 'blocked' }">
          <span class="card-state" :class="a.s"><i /></span><b>{{ a.name }}</b><small>{{ tl(a.label) }}</small>
        </div>
      </aside>
      <section class="tp-chat">
        <header class="tp-head"><UIcon name="i-lucide-chevron-left" /><b>docs-site</b><span class="pill blocked"><i />{{ tl('your turn') }}</span></header>
        <div class="tp-msgs">
          <div class="msg-bubble tp-user">{{ tl('Can you fix the failing test?') }}</div>
          <div class="md md-body tp-reply">
            <p>{{ tl('Fixed: the date was parsed in the wrong') }} <code>timeZone</code>.</p>
            <div class="code-block"><pre><code>const d = parseISO(s, { tz: 'UTC' })</code></pre></div>
          </div>
        </div>
        <div class="tp-composer"><span>{{ tl('Message docs-site…') }}</span><span class="tp-send"><UIcon name="i-lucide-arrow-up" /></span></div>
      </section>
      <section class="tp-set">
        <h5 class="field-label">{{ tl('Settings') }}</h5>
        <div class="tp-set-row"><span>{{ tl('Notifications') }}</span><USwitch :model-value="true" size="xl" /></div>
        <div class="tp-set-row"><span>{{ tl('Read aloud') }}</span><USwitch :model-value="false" size="xl" /></div>
      </section>
      <div class="tp-term">
        <p v-for="(line, i) in TERM" :key="i"><span v-for="([text, n], j) in line" :key="j" :style="{ color: variant.ansi[n] }">{{ text }}</span></p>
        <p class="tp-swatches"><i v-for="(c, i) in variant.ansi" :key="i" :style="{ background: c }" /></p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Nuxt UI tokens read the theme variables where they are declared (:root):
   declared again here, they follow the palette being edited. */
.tp {
  --ui-bg: var(--bg); --ui-bg-elevated: var(--surface-2); --ui-bg-accented: var(--surface-3);
  --ui-border: var(--line); --ui-text: var(--text); --ui-success: var(--green); --ui-primary: var(--text);
  min-width: 0; overflow: hidden; border: 1px solid var(--line); background: var(--bg); color: var(--text);
}
.tp-app {
  zoom: var(--zoom); width: 720px; display: grid; grid-template-columns: 220px minmax(0, 1fr) 190px;
  grid-template-rows: 300px auto; font: 15px/1.45 var(--sans);
}
.tp-side { grid-row: 1 / 3; padding: 14px 12px; background: var(--bg-2); border-right: 1px solid var(--line); min-width: 0; }
.tp-brand { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; color: var(--text-strong); font: 800 17px/1 var(--display); }
.tp-brand .app-logo { width: 32px; height: 14px; color: var(--accent); }
.tp-side .stats { margin-bottom: 16px; }
.tp-side .stat { padding: 8px 8px 7px; }
.tp-side .stat b { font-size: 22px; }
.tp-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; margin-bottom: 4px; border: 1px solid var(--line-soft); background: var(--surface); font-size: 13px; }
.tp-row.on { border-color: var(--line-strong); }
.tp-row b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-row small { margin-left: auto; color: var(--muted); font: 500 10px/1 var(--mono); white-space: nowrap; }
.tp-chat { display: flex; flex-direction: column; min-width: 0; border-right: 1px solid var(--line); }
.tp-head { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; border-bottom: 1px solid var(--line); }
.tp-head b { font-weight: 650; }
.tp-head .pill { margin-left: auto; }
.tp-msgs { flex: 1; display: grid; align-content: start; gap: 10px; padding: 12px; min-height: 0; }
.tp-user { justify-self: end; max-width: 88%; font-size: 13.5px; padding: 7px 11px; }
.tp-reply { font-size: 13.5px; }
.tp-reply p { margin-bottom: .6em; }
.tp-reply pre { padding: 8px 10px; font-size: 11.5px; overflow: hidden; }
.tp-composer { display: flex; align-items: center; gap: 8px; margin: 0 12px 12px; padding: 6px 6px 6px 10px; background: var(--bg-2); border: 1px solid var(--input-line); color: var(--dim); font-size: 13px; }
.tp-send { display: grid; place-items: center; width: 28px; height: 28px; margin-left: auto; background: var(--accent); color: var(--on-accent); }
.tp-set { padding: 14px 12px; min-width: 0; background: var(--bg); }
.tp-set .field-label { margin: 0 0 8px; }
.tp-set-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--line-soft); font-size: 13px; }
.tp-term { grid-column: 2 / 4; padding: 10px 12px; border-top: 1px solid var(--line); background: var(--bg); font: 12px/1.6 var(--mono); }
.tp-term p { margin: 0; white-space: pre; overflow: hidden; }
.tp-term .tp-swatches { display: flex; gap: 3px; margin-top: 6px; }
.tp-swatches i { width: 14px; height: 10px; flex: none; }
</style>
