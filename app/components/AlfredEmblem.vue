<script setup lang="ts">
// Alfred's emblem: the logo's pixel ram (AppLogo) dressed as a butler, a bow
// tie (o) under its chin. The ram follows currentColor, the bow tie the brand mauve.
const G = [
  '.###........###.',
  '#...#.####.#...#',
  '#.#..######..#.#',
  '#..#.######.#..#',
  '.##..#.##.#..##.',
  '.....######.....',
  '......####......',
  '................',
  '.....oo..oo.....',
  '.....oooooo.....',
  '.....oo..oo.....',
]
const path = (c: string) => G.flatMap((row, y) => [...row].map((x, i) => (x === c ? `M${i} ${y}h1v1h-1z` : ''))).join('')
const ram = path('#')
const tie = path('o')
</script>

<template>
  <svg class="alfred-emblem" viewBox="0 0 16 11" shape-rendering="crispEdges" aria-hidden="true" data-testid="alfred-emblem">
    <path fill="currentColor" :d="ram" />
    <path class="alfred-emblem-tie" :d="tie" />
  </svg>
</template>

<style scoped>
.alfred-emblem { flex: none; height: auto; }
.alfred-emblem-tie { fill: var(--mauve); }
</style>
