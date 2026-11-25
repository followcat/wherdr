<script setup lang="ts">
// A conversation with nothing kept on this device yet, while its end loads (ChatView,
// after 300 ms): the shapes of its last blocks, at the bottom where the messages will
// show, above the real (usable) field. Static: no shimmer, no pulse (main.css).
defineProps<{ agent?: string | null }>()
</script>

<template>
  <div class="chat-skel" aria-hidden="true">
    <div class="skel-user"><USkeleton style="width: 78%" /><USkeleton style="width: 52%" /></div>
    <USkeleton class="skel-who" :class="agent || ''" />
    <div class="skel-tool"><span /><USkeleton style="width: 62%" /></div>
    <div class="skel-lines"><USkeleton style="width: 92%" /><USkeleton style="width: 84%" /><USkeleton style="width: 66%" /></div>
    <div class="skel-user"><USkeleton style="width: 64%" /></div>
    <USkeleton class="skel-who" :class="agent || ''" />
    <div class="skel-lines"><USkeleton style="width: 90%" /><USkeleton style="width: 86%" /><USkeleton style="width: 80%" /><USkeleton style="width: 42%" /></div>
  </div>
</template>
