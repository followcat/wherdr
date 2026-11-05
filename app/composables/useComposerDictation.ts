// The composer's mic: hold it (≥ 0.6 s) and release to stop, or tap it to
// start and tap again to stop. The text goes into the draft, at the caret
// when the field has the focus, else at the end; nothing is ever sent alone.
import { computed, nextTick, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { Pane } from '#shared/types'
import { useDictation, type DictationError } from './useDictation'
import { dictationEngine, toast } from './useHerdr'
import { t, tl } from '~/utils/i18n'
import { disposeEngines, ENGINES } from '~/utils/dictation/registry'
import { dictationTerms } from '~/utils/dictation/terms'
import { insertDictated, takeClock, waveText } from '~/utils/dictation/compose'
import { readRewriteOptions, rewriteText } from '~/utils/dictation/rewrite'

export const HOLD_MS = 600

function errorText(e: DictationError): { msg: string, settings: boolean } {
  switch (e.reason) {
    case 'not-installed': return { msg: tl('Dictation is not ready: its model is not installed', 'La dictée n’est pas prête : son modèle n’est pas installé'), settings: true }
    case 'no-key': return { msg: tl('Dictation needs an OpenRouter key', 'La dictée a besoin d’une clé OpenRouter'), settings: true }
    case 'unsupported': return { msg: tl('This device cannot run this dictation engine', 'Cet appareil ne peut pas faire tourner ce moteur de dictée'), settings: true }
    case 'offline': return { msg: tl('Dictation is unavailable offline', 'La dictée est indisponible hors ligne'), settings: true }
    case 'too-large': return { msg: tl('Dictation stopped: the model is too large for this device. Choose a lighter one in Settings', 'Dictée arrêtée : le modèle est trop lourd pour cet appareil. Choisissez-en un plus léger dans Réglages'), settings: true }
    case 'mic': return { msg: tl('Microphone unavailable', 'Micro indisponible'), settings: false }
    case 'timeout': return { msg: tl('Dictation took too long: nothing was written', 'La dictée a pris trop de temps : rien n’a été écrit'), settings: false }
    default: return { msg: tl('Dictation failed', 'La dictée a échoué'), settings: false }
  }
}

export function useComposerDictation(o: { text: Ref<string>, ta: ComputedRef<HTMLTextAreaElement | null>, pane: () => Pane | undefined }) {
  const d = useDictation()
  const engine = computed(() => dictationEngine.value !== 'off' && ENGINES[dictationEngine.value] ? dictationEngine.value : null)
  const live = computed(() => d.status.value === 'preparing' || d.status.value === 'recording')
  const working = computed(() => d.status.value === 'transcribing' || d.status.value === 'rewriting')
  const shown = computed(() => live.value || working.value)
  const wave = computed(() => waveText(d.levels.value))
  const clock = computed(() => takeClock(d.recMs.value))
  const loading = computed(() => {
    const p = d.progress.value
    return p?.total ? `${Math.round((p.got || 0) / p.total * 100)}%` : ''
  })

  function insert(add: string) {
    const el = o.ta.value
    const focused = Boolean(el && document.activeElement === el)
    const r = insertDictated(o.text.value, add, focused ? { start: el!.selectionStart, end: el!.selectionEnd } : null)
    o.text.value = r.text
    if (focused) nextTick(() => el!.setSelectionRange(r.caret, r.caret))
  }

  // A take that cannot start or ends in an error: one toast, then back to idle.
  watch(d.error, (e) => {
    if (!e) return
    const { msg, settings } = errorText(e)
    // The model is now marked too large: the next press loads a fresh engine,
    // on the model Settings shows (one that fits).
    if (e.reason === 'too-large') disposeEngines()
    toast(msg, true, settings ? undefined : e.detail, settings
      ? { label: t('Settings'), run: () => navigateTo({ path: '/settings', query: { section: 'conversation' } }) }
      : undefined)
    d.cancel()
  })

  async function begin() {
    const id = engine.value
    if (!id) return
    const p = o.pane()
    const terms = dictationTerms({ agent: p?.agent, machine: p?.machine, name: p?.name, title: p?.title, cwd: p?.cwd, draft: o.text.value })
    // The optional rewrite: on failure the raw text goes in, and a toast says so.
    const rw = readRewriteOptions()
    const rewrite = rw.on
      ? async (text: string, signal: AbortSignal) => {
          const r = await rewriteText(text, signal, rw)
          if (r.error) toast(tl('Rewrite failed: the raw transcript was kept', 'La reformulation a échoué : la transcription brute est gardée'), true, r.error)
          return r.text
        }
      : undefined
    try { await d.start({ engine: id, terms, onText: insert, rewrite }) }
    catch { toast(tl('The microphone is in use in another pane', 'Le micro est pris dans un autre panneau'), true) }
  }

  let pressAt = 0
  let pressing = false
  function down(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // A tap-started take: this press ends it.
    if (live.value) { pressing = false; void d.stop(); return }
    if (working.value) return
    try { (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId) }
    catch { /* already released */ }
    pressing = true
    pressAt = performance.now()
    void begin()
  }
  // Held long enough: release stops. A short tap leaves it recording.
  function up() {
    if (!pressing) return
    pressing = false
    if (performance.now() - pressAt >= HOLD_MS) void d.stop()
  }
  // Keyboard (Enter, Space): a toggle. Pointer clicks are handled above.
  function click(e: MouseEvent) {
    if (e.detail !== 0) return
    if (live.value) void d.stop()
    else if (!working.value) void begin()
  }

  return {
    engine, status: d.status, live, shown, wave, clock, loading,
    down, up, click, cancel: () => { pressing = false; d.cancel() },
  }
}
