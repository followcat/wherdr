<script setup lang="ts">
// Settings › Projects › Add workspace (docs/workspaces.md): the workspace form
// (WorkspaceForm, shared with the New sheet's Project › Workspace), a fresh
// one at each opening; closed once its coordinator started.
const open = defineModel<boolean>('open', { default: false })
defineProps<{ taken: string[] }>()
const emit = defineEmits<{ added: [key: string] }>()

const opening = ref(0)
const busy = ref(false)
const error = ref('')
const browsing = ref(false)
watch(open, (o) => { if (o) { opening.value++; browsing.value = false } })
</script>

<template>
  <AppSheet v-model:open="open" :title="tl('Add workspace')" tall>
    <WorkspaceForm
      :key="opening" v-model:busy="busy" v-model:error="error" v-model:browsing="browsing" :taken="taken"
      @added="k => emit('added', k)" @done="open = false"
    />
    <template #footer>
      <div v-if="!browsing" class="sheet-form">
        <p v-if="error" class="form-error" role="alert" data-testid="add-workspace-refused">{{ error }}</p>
        <UButton type="submit" form="add-workspace" block size="xl" color="primary" class="hw-cta" icon="i-lucide-plus" :loading="busy" data-testid="add-workspace-submit">{{ tl('Create') }}</UButton>
      </div>
    </template>
  </AppSheet>
</template>
