<script setup lang="ts">
// Strip at the top of the demo build: says nothing runs, links to the install guide.
import { tl } from '~/utils/i18n'
</script>

<template>
  <div class="demo-banner" role="note">
    <span class="demo-tag">DEMO</span>
    <span class="demo-text">{{ tl('Nothing runs', 'Rien ne tourne') }}</span>
    <a class="demo-link" href="/#install">{{ tl('Install wherdr', 'Installer wherdr') }} →</a>
  </div>
</template>

<style>
/* Every screen of the app is a fixed `.view`: they start under the strip. */
:root { --demo-h: 28px; }
.view { top: var(--demo-h) !important; height: calc(100% - var(--demo-h)) !important; }
:is(.list-handle, .panel-handle) { top: var(--demo-h) !important; }
.demo-banner {
  position: fixed; z-index: 100; left: 0; right: 0; top: 0; height: var(--demo-h);
  display: flex; align-items: center; justify-content: center; gap: 10px; padding: 0 12px;
  background: var(--ui-bg); border-bottom: 1px solid var(--ui-border);
  font: 500 11px/1 var(--font-mono, ui-monospace, monospace); letter-spacing: .06em; text-transform: uppercase;
  color: var(--ui-text-muted); white-space: nowrap;
}
.demo-tag { color: var(--ui-bg); background: var(--ui-primary); padding: 3px 6px; font-weight: 700; }
.demo-text { overflow: hidden; text-overflow: ellipsis; }
.demo-link { color: var(--ui-primary); text-decoration: none; font-weight: 700; }
.demo-link:hover { text-decoration: underline; }
</style>
