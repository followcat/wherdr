<script setup lang="ts">
// Every device registered for Web Push, each with the result of its own last
// delivery: one device's success never hides another's failure.
import type { PushDeviceView } from '../../shared/pushDelivery'

const PROVIDERS: Record<string, [string, string]> = {
  apple: ['Apple (Safari, iPhone, iPad)', 'Apple (Safari, iPhone, iPad)'],
  google: ['Chrome or Android', 'Chrome ou Android'],
  mozilla: ['Firefox', 'Firefox'],
  microsoft: ['Edge (Windows)', 'Edge (Windows)'],
}
const providerLabel = (p: string) => PROVIDERS[p] ? tl(...PROVIDERS[p]!) : tl('Other browser', 'Autre navigateur')
const when = (iso: string) => new Date(iso).toLocaleString(language === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function result(d: PushDeviceView): { text: string, tone: 'ok' | 'bad' | 'none' } {
  const last = d.last
  if (!last) return { text: tl('Nothing sent yet', 'Rien d’envoyé pour l’instant'), tone: 'none' }
  const at = when(last.at)
  const code = last.code ? ` (${last.code})` : ''
  switch (last.status) {
    case 'ok': return { text: tl(`Delivered · ${at}`, `Distribuée · ${at}`), tone: 'ok' }
    case 'expired': return { text: tl(`Expired${code} · ${at}: this subscription no longer exists`, `Expirée${code} · ${at} : cet abonnement n’existe plus`), tone: 'bad' }
    case 'rejected': return { text: tl(`Rejected by the push service${code} · ${at}`, `Refusée par le service push${code} · ${at}`), tone: 'bad' }
    case 'network': return { text: tl(`Push service unreachable · ${at}`, `Service push injoignable · ${at}`), tone: 'bad' }
    default: return { text: tl(`Failed${code} · ${at}`, `Échec${code} · ${at}`), tone: 'bad' }
  }
}
onMounted(() => refreshPushDevices())
</script>

<template>
  <div v-if="pushDevices && pushDevices.length" class="settings-card push-devices" data-testid="push-devices">
    <p class="muted">{{ tl('Registered devices and the result of the last notification sent to each.', 'Appareils enregistrés et résultat de la dernière notification envoyée à chacun.') }}</p>
    <ul>
      <li v-for="d in pushDevices" :key="d.id" data-testid="push-device">
        <div class="push-device-main">
          <b>{{ providerLabel(d.provider) }}<small v-if="d.current">{{ tl('This device', 'Cet appareil') }}</small></b>
          <span class="muted">{{ tl(`Added ${when(d.addedAt)}`, `Ajouté ${when(d.addedAt)}`) }}</span>
          <span :class="`push-result push-result-${result(d).tone}`">{{ result(d).text }}</span>
        </div>
        <button v-if="d.last?.status === 'expired'" type="button" class="push-device-remove" @click="refreshPushDevices(d.id)">
          <UIcon name="i-lucide-trash-2" />{{ tl('Remove', 'Retirer') }}
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.push-devices { margin-top: 10px; padding-top: 12px; }
.push-devices p { margin: 0 0 4px; font-size: 13px; }
.push-devices ul { list-style: none; margin: 0; padding: 0; }
.push-devices li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line-soft); }
.push-devices li:first-child { border-top: 0; }
.push-device-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 13px; overflow-wrap: anywhere; }
.push-device-main b { font-size: 14.5px; font-weight: 500; }
.push-device-main small { margin-left: 8px; font: 500 10.5px/1 var(--mono); text-transform: uppercase; color: var(--accent); }
.push-result { font-family: var(--mono); font-size: 12px; }
.push-result-ok { color: var(--green); }
.push-result-bad { color: var(--danger); }
.push-result-none { color: var(--muted); }
.push-device-remove { flex: none; display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 12px; border: 1px solid var(--line); background: none; color: var(--danger); font-size: 13px; cursor: pointer; }
.push-device-remove:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }
</style>
