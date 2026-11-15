<script setup lang="ts">
// The home list before its first load is in (HomeView, useHomeLoad): Alfred's
// card, then each section's heading with rows at the size of the real ones,
// instead of drawing the sections that happen to be ready. Headings are shapes
// too: which sections there will be is not known yet.
const groups = [{ rows: 2, coord: true }, { rows: 3 }, { rows: 2 }]
</script>

<template>
  <div class="home-skel" role="status" :aria-label="tl('Loading')" aria-busy="true" data-testid="home-skeleton">
    <div class="home-skel-alfred"><span class="skel home-skel-mark" /><span class="home-skel-lines"><i class="skel" style="width: 34%" /><i class="skel" style="width: 62%" /><i class="skel" style="width: 46%" /></span></div>
    <section v-for="(g, i) in groups" :key="i" class="agent-group">
      <h2 class="group-title"><i class="skel home-skel-title" :style="{ width: `${92 - i * 14}px` }" /></h2>
      <div class="card-list">
        <div v-for="n in g.rows" :key="n" class="home-skel-row" :class="{ coord: g.coord }" data-testid="home-skeleton-row">
          <span class="home-skel-lines"><i class="skel" :style="{ width: `${68 - n * 11}%` }" /><i class="skel" :style="{ width: `${44 - n * 6}%` }" /></span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Same boxes as AlfredRow, CoordinatorsSection and AgentCard, so nothing moves when the data lands. */
.home-skel-alfred { display: flex; align-items: center; gap: 12px; min-height: 78px; margin-bottom: 20px; padding: 10px 12px; border: 1px solid var(--line); background: var(--surface); }
.home-skel-mark { flex: none; width: 40px; height: 40px; }
.home-skel-lines { display: grid; flex: 1; gap: 7px; min-width: 0; }
.home-skel-lines i { height: 12px; }
.home-skel-lines i + i { height: 10px; }
.home-skel-title { height: 10px; }
.home-skel-row { display: flex; align-items: center; min-height: var(--home-skel-row, 64px); padding: 0 14px 0 16px; background: var(--bg-2); }
.home-skel-row + .home-skel-row { border-top: 1px solid var(--line-soft); }
.home-skel-row.coord { min-height: 53px; padding: 0 12px; background: var(--surface); }
:global(.list-compact) .home-skel-row:not(.coord) { --home-skel-row: 44px; }
:global(.list-compact) .home-skel-row:not(.coord) .home-skel-lines i + i { display: none; }
</style>
