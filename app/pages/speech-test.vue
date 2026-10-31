<script setup lang="ts">
const sp = useSpeech()
const file = ref<File | null>(null)
const wavMs = ref(0)
const mem = ref('')

onUnmounted(() => sp.dispose())

function fmtMB(n: number) { return (n / 1048576).toFixed(1) + ' MB' }
function readMem() {
  const m = (performance as any).memory
  mem.value = m ? `JS heap ${fmtMB(m.usedJSHeapSize)} / ${fmtMB(m.jsHeapSizeLimit)}` : 'n/a'
}

async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  file.value = f
  const t0 = performance.now()
  await sp.decodeBlob(f)
  wavMs.value = Math.round(performance.now() - t0)
}
</script>

<template>
  <div class="asr-test">
    <h1>Local ASR test</h1>
    <p class="dim">sherpa-onnx WASM · streaming zipformer zh-en int8 · 16 kHz mono · runs in a worker</p>

    <div class="row">
      <button v-if="sp.status.value === 'idle' || sp.status.value === 'error'" @click="sp.ensure().catch(() => {})">Load model</button>
      <template v-else>
        <button v-if="sp.status.value !== 'recording'" :disabled="sp.status.value !== 'ready'" @click="sp.startMic().catch(() => {})">🎙 Record</button>
        <button v-else class="stop" @click="sp.stopMic()">■ Stop</button>
        <button :disabled="sp.status.value !== 'ready'" @click="sp.reset()">Reset</button>
      </template>
      <button @click="readMem">mem</button>
    </div>

    <div class="status">
      <span class="chip">{{ sp.status.value }}</span>
      <span v-if="sp.phase.value" class="dim">{{ sp.phase.value }}</span>
      <span v-if="mem" class="dim">{{ mem }}</span>
    </div>

    <div v-if="sp.dl.value" class="dl">
      <div>{{ sp.dl.value.file }}</div>
      <progress :value="sp.dl.value.got" :max="sp.dl.value.total || 1" />
      <span class="dim">{{ fmtMB(sp.dl.value.got) }} / {{ sp.dl.value.total ? fmtMB(sp.dl.value.total) : '?' }}</span>
    </div>

    <div class="row">
      <label class="file">WAV file<input type="file" accept="audio/*,.wav" @change="onFile" /></label>
      <span v-if="wavMs" class="dim">decode+feed {{ wavMs }} ms</span>
    </div>

    <div class="out">
      <div v-for="(s, i) in sp.segments.value" :key="i" class="seg">{{ s }}</div>
      <div v-if="sp.partial.value" class="partial">{{ sp.partial.value }}</div>
      <div v-if="sp.finalText.value" class="final">{{ sp.finalText.value }}</div>
    </div>

    <dl v-if="sp.loadMs.value" class="stats">
      <div><dt>model load</dt><dd>{{ sp.loadMs.value }} ms</dd></div>
      <div v-if="sp.decodeMs.value !== null"><dt>final decode</dt><dd>{{ sp.decodeMs.value }} ms</dd></div>
    </dl>

    <pre v-if="sp.error.value" class="err">{{ sp.error.value }}</pre>
  </div>
</template>

<style scoped>
.asr-test { max-width: 640px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
h1 { font-size: 18px; }
.dim { opacity: .55; font-size: 12px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
button { padding: 10px 18px; border-radius: 10px; border: 1px solid var(--line, #444); background: var(--bg-2, #1c1c1e); color: inherit; font-size: 15px; }
button.stop { border-color: #e5484d; color: #e5484d; }
button:disabled { opacity: .4; }
.status { display: flex; gap: 8px; align-items: center; }
.chip { padding: 3px 10px; border-radius: 999px; background: var(--bg-2, #1c1c1e); border: 1px solid var(--line, #444); font-size: 12px; }
.dl progress { width: 100%; }
.file input { font-size: 12px; max-width: 220px; }
.out { min-height: 80px; padding: 12px; border: 1px solid var(--line, #444); border-radius: 10px; }
.seg { opacity: .75; }
.partial { opacity: .5; }
.final { font-weight: 600; }
.stats { display: flex; gap: 20px; font-size: 13px; }
.stats dt { opacity: .55; } .stats dd { margin: 0; }
.err { color: #e5484d; font-size: 11px; white-space: pre-wrap; }
</style>
