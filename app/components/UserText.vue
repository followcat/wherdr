<script setup lang="ts">
// Text of a user message, the only thing in its bubble: the user's own words
// (folded when long), without the long pasted texts, which show as tiles
// above the bubble (MsgAttachments, see shared/pastedText.ts).
import { sentSplit } from '~/utils/attachTiles'

const props = defineProps<{ text: string, pasted?: string[] }>()
const words = computed(() => sentSplit(props.text, props.pasted).text)
</script>

<template>
  <FoldText v-if="words"><QuotedText :text="words" /></FoldText>
</template>
