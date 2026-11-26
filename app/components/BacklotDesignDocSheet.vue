<script setup lang="ts">
// Read-only sheet displaying a studio's opening design document (`design/v<N>.md`
// or `design/v<N>-final.md`) rendered as Markdown with jumpable `## R<r>` and
// `### §R<r>.<W|D|P|U>` headings at the top.
import type { BacklotDesignSection, BacklotMachineView, BacklotStudio } from '#shared/backlot'
import { backlotActionTarget, extractDesignSections } from '#shared/backlot'
import { fetchBacklotDesignDoc } from '~/composables/useBacklot'
import { md } from '~/utils/markdown'

const props = defineProps<{ machine: BacklotMachineView | null, studio: BacklotStudio | null, file: string | null }>()
const open = defineModel<boolean>('open', { default: false })

const loading = ref(false)
const error = ref('')
const text = ref('')
const truncated = ref(false)
const articleEl = ref<HTMLElement | null>(null)
let fetchSeq = 0

const title = computed(() => (props.studio && props.file ? `${props.studio.title} · ${props.file}` : props.file || t('Design document')))
const sections = computed<BacklotDesignSection[]>(() => (text.value ? extractDesignSections(text.value) : []))
const rendered = computed(() => (text.value ? md(text.value, { doc: true }) : ''))

async function load() {
  if (!open.value || !props.machine || !props.studio || !props.file) return
  const seq = ++fetchSeq
  loading.value = true
  error.value = ''
  text.value = ''
  truncated.value = false
  try {
    const r = await fetchBacklotDesignDoc({
      ...backlotActionTarget(props.machine),
      studio: props.studio.id,
      file: props.file,
    })
    if (seq !== fetchSeq) return
    if (r.ok && typeof r.text === 'string') {
      text.value = r.text
      truncated.value = Boolean(r.truncated)
    } else {
      error.value = r.error || t('Could not read design document')
    }
  } catch (e) {
    if (seq === fetchSeq) error.value = (e as Error).message || t('Could not read design document')
  } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

function attachHeadingIds() {
  const el = articleEl.value
  if (!el || !sections.value.length) return
  const headings = [...el.querySelectorAll<HTMLElement>('h2, h3')]
  let cursor = 0
  for (const sec of sections.value) {
    const tag = `H${sec.level}`
    for (let i = cursor; i < headings.length; i++) {
      const h = headings[i]!
      if (h.tagName === tag && h.textContent?.trim() === sec.text) {
        h.id = sec.id
        cursor = i + 1
        break
      }
    }
  }
}

function jumpTo(id: string) {
  const target = articleEl.value?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

watch([open, () => props.machine?.session, () => props.machine?.machine, () => props.studio?.id, () => props.file], () => {
  if (open.value) void load()
  else {
    fetchSeq++
    loading.value = false
    error.value = ''
    text.value = ''
    truncated.value = false
  }
}, { immediate: true })

watch(rendered, attachHeadingIds, { flush: 'post' })
</script>

<template>
  <AppSheet v-model:open="open" :title="title" tall top>
    <div class="bld" data-testid="backlot-design-doc-sheet">
      <div v-if="loading" class="bld-skel" data-testid="backlot-design-doc-loading">
        <USkeleton class="bld-skel-line short" />
        <USkeleton class="bld-skel-line" />
        <USkeleton class="bld-skel-line" />
        <USkeleton class="bld-skel-line mid" />
      </div>

      <div v-else-if="error" class="bld-err-box" role="alert">
        <p class="bl-error">{{ error }}</p>
        <button type="button" class="mono-btn bl-btn" @click="load">
          <UIcon name="i-lucide-rotate-ccw" />{{ t('Try again') }}
        </button>
      </div>

      <template v-else-if="text">
        <nav v-if="sections.length" class="bld-nav" :aria-label="t('Design sections')" data-testid="backlot-design-jumps">
          <button
            v-for="sec in sections" :key="sec.id" type="button" class="bld-jump"
            :class="{ round: sec.level === 2 }" data-testid="backlot-design-jump" @click="jumpTo(sec.id)"
          >
            {{ sec.label }}
          </button>
        </nav>

        <p v-if="truncated" class="bld-trunc">{{ t('Document truncated to keep this view responsive.') }}</p>
        <!-- eslint-disable-next-line vue/no-v-html -- sanitized by md() (utils/markdown.ts) -->
        <article ref="articleEl" class="md md-body bld-md" v-html="rendered" />
      </template>

      <p v-else class="bl-meta">{{ t('Design document is empty.') }}</p>
    </div>
  </AppSheet>
</template>

<style scoped>
.bld { display: grid; gap: 12px; min-width: 0; }
.bld-skel { display: grid; gap: 8px; }
.bld-skel-line { height: 14px; width: 100%; }
.bld-skel-line.short { width: 42%; }
.bld-skel-line.mid { width: 72%; }
.bld-err-box { display: grid; gap: 10px; justify-items: start; }
.bl-error { margin: 0; color: var(--blocked); font: 400 12px/1.35 var(--mono); overflow-wrap: anywhere; }
.bl-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 12px; border: 1px solid var(--line); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; touch-action: manipulation; }
.bl-btn:hover { background: var(--surface-2); }
.bld-nav { display: flex; flex-wrap: wrap; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid var(--line-soft); min-width: 0; }
.bld-jump { display: inline-flex; align-items: center; min-height: 44px; padding: 0 10px; border: 1px solid var(--line); background: var(--surface); color: var(--text-2); font: 500 11px/1.2 var(--mono); cursor: pointer; touch-action: manipulation; overflow-wrap: anywhere; text-align: left; }
.bld-jump.round { border-color: var(--accent); color: var(--text); }
.bld-jump:hover { background: var(--surface-2); color: var(--text); }
.bld-jump:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }
.bld-trunc { margin: 0; padding: 8px 10px; border: 1px solid var(--blocked); color: var(--blocked); font: 400 12px/1.35 var(--mono); }
.bld-md { min-width: 0; }
.bld-md :deep(h2), .bld-md :deep(h3) { scroll-margin-top: 12px; }
</style>
