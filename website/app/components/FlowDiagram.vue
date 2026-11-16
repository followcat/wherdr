<script setup lang="ts">
// phone / laptop ⇄ (private network) ⇄ wherdr ⇄ herdr-core ⇄ agents.
// Plain HTML boxes and 1 px links with packets gliding along them (CSS only).
const agents = [
  { name: 'Claude Code', color: 'var(--claude)' },
  { name: 'Codex', color: 'var(--codex)' },
  { name: 'omp', color: 'var(--omp)' },
  { name: 'Devin, any terminal', color: 'var(--dim)' },
]
</script>

<template>
  <div class="flow" role="img" aria-label="Your phone or laptop reaches wherdr through your private network (Tailscale). wherdr runs next to herdr-core (hc) on your server and talks to its local socket; hc runs your coding agents.">
    <div class="node devices">
      <span class="label"><span class="k">01</span> You</span>
      <div class="title">Phone &amp; laptop</div>
      <ul><li>PWA · push</li><li>any browser</li></ul>
    </div>
    <div class="link net">
      <span class="tag">tailnet · HTTPS</span>
      <i class="pkt" style="--d: 3.1s; --o: -0.4s" /><i class="pkt rev" style="--d: 4.7s; --o: -2.9s" />
    </div>
    <div class="node wherdr fx-ring halo">
      <span class="label"><span class="k">02</span> wherdr</span>
      <div class="title">wherdr</div>
      <ul><li>Nitro · 127.0.0.1</li><li>passkey lock</li></ul>
    </div>
    <div class="link">
      <span class="tag">unix socket</span>
      <i class="pkt" style="--d: 3.7s; --o: -1.6s" /><i class="pkt rev" style="--d: 5.3s; --o: -0.9s" />
    </div>
    <div class="node">
      <span class="label"><span class="k">03</span> herdr-core</span>
      <div class="title">hc</div>
      <ul><li>spaces · tabs</li><li>SSH machines</li></ul>
    </div>
    <div class="link">
      <span class="tag">PTY</span>
      <i class="pkt" style="--d: 4.3s; --o: -3.4s" /><i class="pkt rev" style="--d: 6.1s; --o: -4.2s" />
    </div>
    <div class="node agents">
      <span class="label"><span class="k">04</span> Agents</span>
      <ul class="ag">
        <li v-for="a in agents" :key="a.name"><span class="sq" :style="{ background: a.color }" />{{ a.name }}</li>
      </ul>
    </div>
    <div class="zone" aria-hidden="true"><span class="label">your server · your private network · no cloud</span></div>
  </div>
</template>

<style scoped>
.flow {
  position: relative; display: grid; align-items: stretch;
  grid-template-columns: 1fr minmax(60px, .7fr) 1fr minmax(60px, .55fr) 1fr minmax(48px, .45fr) 1.1fr;
  padding: 56px 28px 28px; border: 1px solid var(--line); background: var(--bg-2);
}
.zone { position: absolute; top: 18px; left: calc(28px + (100% - 56px) * .27); right: 28px; height: calc(100% - 36px); border: 1px dashed var(--line-strong); pointer-events: none; }
.zone .label { position: absolute; top: -9px; left: 16px; padding: 0 8px; background: var(--bg-2); font-size: 10px; color: var(--dim); }
.node { position: relative; z-index: 1; display: grid; align-content: start; gap: 8px; padding: 16px; border: 1px solid var(--line-strong); background: var(--surface); }
/* z-index auto: a stacking context of its own would paint the halo over its fill. */
.node.wherdr { z-index: auto; --fx-fill: var(--surface); border-color: transparent; background: linear-gradient(var(--fx-fill), var(--fx-fill)) padding-box, var(--fx-ring) border-box; }
.node .label { font-size: 10px; }
.title { font-family: var(--display); font-weight: 800; font-size: 20px; color: #fff; letter-spacing: -0.02em; }
ul { margin: 0; padding: 0; list-style: none; font: 12px/1.7 var(--mono); color: var(--muted); }
.ag li { display: flex; align-items: center; gap: 8px; color: var(--text); }
.sq { width: 8px; height: 8px; flex: none; }
.link { position: relative; align-self: center; height: 1px; background: var(--line-strong); }
.link .tag { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); white-space: nowrap; font: 10px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
.net { background: repeating-linear-gradient(90deg, var(--accent) 0 6px, transparent 6px 10px); opacity: .9; }
/* Each packet has its own period and offset (prime-ish, so they never fall in step), eases in
   and out, then rests unseen for the second half of its period: an irregular, calm traffic. */
.pkt { position: absolute; top: -2px; left: 0; width: 6px; height: 5px; background: var(--accent); box-shadow: 0 0 10px var(--accent); opacity: 0; animation: go var(--d, 3.5s) var(--o, 0s) infinite; }
.pkt.rev { background: var(--violet); box-shadow: 0 0 10px var(--violet); animation-direction: reverse; }
@keyframes go {
  0% { left: 0; opacity: 0; animation-timing-function: cubic-bezier(.45, 0, .25, 1); }
  5% { opacity: 1; }
  48% { opacity: 1; }
  54% { left: calc(100% - 6px); opacity: 0; }
  100% { left: calc(100% - 6px); opacity: 0; }
}
@media (max-width: 960px) {
  .flow { grid-template-columns: 1fr; padding: 48px 20px 20px; }
  .zone { display: none; }
  .link { justify-self: center; width: 1px; height: 56px; }
  .net { background: repeating-linear-gradient(180deg, var(--accent) 0 6px, transparent 6px 10px); }
  .link .tag { bottom: auto; top: 50%; left: 14px; transform: translateY(-50%); }
  .pkt { left: -2px; top: 0; width: 5px; height: 6px; animation-name: down; }
  @keyframes down {
    0% { top: 0; opacity: 0; animation-timing-function: cubic-bezier(.45, 0, .25, 1); }
    5% { opacity: 1; }
    48% { opacity: 1; }
    54% { top: calc(100% - 6px); opacity: 0; }
    100% { top: calc(100% - 6px); opacity: 0; }
  }
}
</style>
