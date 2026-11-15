<script setup lang="ts">
import { DISCORD, REPO } from '~/utils/site'
const links = [
  { label: 'Why', to: '#why' },
  { label: 'Features', to: '#features' },
  { label: 'How it works', to: '#how' },
  { label: 'Security', to: '#security' },
  { label: 'Install', to: '#install' },
  { label: 'FAQ', to: '#faq' },
  { label: 'Demo', to: '/demo/' },
]
const open = ref(false)
</script>

<template>
  <header class="hdr">
    <div class="wrap row">
      <a href="#top" class="brand" aria-label="wherdr, back to top">
        <PixelMark class="logo" />
        <PixelMark class="name" text="wherdr" />
      </a>
      <nav class="nav" aria-label="Sections">
        <a v-for="l in links" :key="l.to" :href="l.to">{{ l.label }}</a>
      </nav>
      <div class="end">
        <a class="dc" :href="DISCORD" target="_blank" rel="noopener" aria-label="Discord">
          <DiscordMark />
        </a>
        <a class="gh" :href="REPO" target="_blank" rel="noopener">
          <GithubMark />
          <span>GitHub</span>
        </a>
        <button type="button" class="burger" :aria-expanded="open" aria-controls="mnav" aria-label="Menu" @click="open = !open">
          <UIcon :name="open ? 'i-lucide-x' : 'i-lucide-menu'" class="size-5" />
        </button>
      </div>
    </div>
    <nav v-show="open" id="mnav" class="mnav" aria-label="Sections">
      <a v-for="l in links" :key="l.to" :href="l.to" @click="open = false">{{ l.label }}</a>
    </nav>
  </header>
</template>

<style scoped>
.hdr {
  position: sticky; top: 0; z-index: 50;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--line);
}
.row { display: flex; align-items: center; gap: 32px; height: 60px; }
.brand { display: flex; align-items: center; gap: 9px; flex: none; text-decoration: none; color: var(--text); }
/* 3 px per pixel for both marks (16 and 35 columns, 7 rows): one drawing, sharp edges. */
.logo { width: 48px; height: 21px; flex: none; }
.name { width: 105px; height: 21px; flex: none; }
.nav { display: flex; gap: 28px; margin-left: auto; }
.nav a, .mnav a {
  font: 500 12px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase;
  color: var(--muted); text-decoration: none; transition: color .15s;
}
.nav a:hover { color: var(--text); }
.end { display: flex; align-items: center; gap: 8px; }
.gh {
  display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px;
  border: 1px solid var(--line-strong); color: var(--text); text-decoration: none;
  font: 600 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase;
}
.gh:hover, .dc:hover { border-color: var(--text); }
.dc {
  display: inline-grid; place-items: center; width: 34px; height: 34px;
  border: 1px solid var(--line-strong); color: var(--text);
}
.burger { display: none; width: 34px; height: 34px; place-items: center; background: none; border: 1px solid var(--line-strong); color: var(--text); cursor: pointer; }
.mnav { display: grid; border-top: 1px solid var(--line); }
.mnav a { padding: 16px var(--pad); border-bottom: 1px solid var(--line); font-size: 13px; }
@media (max-width: 860px) {
  .nav { display: none; }
  .end { margin-left: auto; }
  .burger { display: grid; }
}
/* Small phones: icon-only GitHub link (label kept for screen readers). */
@media (max-width: 480px) {
  .row { gap: 16px; }
  .gh { width: 34px; padding: 0; justify-content: center; }
  .gh span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
}
@media (min-width: 861px) { .mnav { display: none !important; } }
</style>
