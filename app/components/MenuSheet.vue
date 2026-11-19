<script setup lang="ts">
// Menu as a sheet: actions (rename, close…), agent commands. `top`: it opens
// from inside other sheets (a project sheet's ⋯), so it shows above them.
function run(item: MenuItem) {
  if (item.disabled) return
  menuState.open = false
  item.run?.()
}
</script>

<template>
  <AppSheet v-model:open="menuState.open" :title="menuState.title" top>
    <div class="menu">
      <template v-for="(it, i) in menuState.items" :key="i">
        <div v-if="it.kind === 'separator'" class="menu-sep" />
        <p v-else-if="it.kind === 'note'" class="menu-note">{{ it.label }}</p>
        <p v-else-if="it.kind === 'group'" class="menu-group">{{ it.label }}</p>
        <button v-else-if="it.kind === 'command'" type="button" :disabled="it.disabled" @click="run(it)">
          <span class="cmd">{{ it.cmd }}</span><span class="desc">{{ it.desc }}</span>
        </button>
        <button v-else type="button" :disabled="it.disabled" :class="{ danger: it.danger }" @click="run(it)">
          <UIcon v-if="it.icon" :name="it.icon" class="menu-icon" />
          <span v-if="it.desc" class="menu-text"><span>{{ it.label }}</span><span class="menu-sub" :class="{ 'font-mono': it.mono }">{{ it.desc }}</span></span>
          <template v-else>{{ it.label }}</template>
        </button>
      </template>
    </div>
  </AppSheet>
</template>
