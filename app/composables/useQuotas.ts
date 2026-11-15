// Home quotas (/api/quotas): loaded by HomeView every minute
// when shown and the page is visible, kept offline; read by the top tables
// and the machine ones (QuotaStrip) and by the Claude status line setup (Settings, setup guide, machine menu).
import type { Quotas } from '#shared/types'
import { readQuotas, saveQuotas } from '~/utils/offlineCache'
import { mayReadOffline, readOfflineAccess } from '~/utils/offlineAccess'
import { claudeInstallCommand, claudeSetupRows } from '~/utils/quotas'
import { keepIfSame } from '~/utils/keepIfSame'

export const quotaNow = ref(Date.now())

export async function reloadQuotas() {
  try {
    const q = await api<Quotas>('/api/quotas')
    // Unchanged quotas keep the same object: the tables do not re-render.
    homeQuotas.value = keepIfSame(homeQuotas.value ?? undefined, q)
    if (mayReadOffline(readOfflineAccess())) saveQuotas(q)
    markHomeLoad('quotas', true)
  }
  catch { markHomeLoad('quotas', false) /* retry on the next round */ }
  quotaNow.value = Date.now()
}

export function useQuotaLoader() {
  let timer: ReturnType<typeof setInterval> | null = null
  onMounted(() => {
    if (mayReadOffline(readOfflineAccess())) readQuotas().then((q) => { if (!homeQuotas.value) homeQuotas.value = q })
    if (showQuotas.value) reloadQuotas()
    else markHomeLoad('quotas', true)
    timer = setInterval(() => { if (pageVisible.value && showQuotas.value) reloadQuotas() }, 60000)
  })
  onUnmounted(() => { if (timer) clearInterval(timer) })
  watch([pageVisible, showQuotas], ([v, on]) => { if (v && on) reloadQuotas() })
}

// ------------------------------------------------ Claude quota status line
// Install, copy the command, or stop suggesting it: Settings › Agents, the
// setup guide and the home machine menu (never a banner in the list).
export async function installClaudeQuotas(key: string, name: string, update = false): Promise<boolean> {
  haptic()
  const ok = await askConfirm(
    update
      ? tl(`Update the Claude quota status line on ${name}? It displays nothing and keeps any existing status line (~/.claude/settings.json, backup copy).`,
          `Mettre à jour la barre d’état des quotas Claude sur ${name} ? Elle n’affiche rien et garde une barre d’état existante (~/.claude/settings.json, copie de sauvegarde).`)
      : tl(`Install the Claude quota status line on ${name}? It displays nothing and keeps any existing status line (~/.claude/settings.json, backup copy).`,
          `Installer la barre d’état des quotas Claude sur ${name} ? Elle n’affiche rien et garde une barre d’état existante (~/.claude/settings.json, copie de sauvegarde).`),
    update ? tl('Update', 'Mettre à jour') : t('Install'), 'primary',
  )
  if (!ok) return false
  try {
    await api('/api/claude-statusline', { key })
    toast(tl(`Installed on ${name}. Quotas will show after the next exchange with a Claude.`,
      `Installé sur ${name}. Les quotas apparaîtront après le prochain échange avec un Claude.`))
    await reloadQuotas()
    return true
  } catch (err) {
    toast((err as Error).message, true)
    return false
  }
}

export async function copyClaudeQuotasCommand(name: string) {
  haptic()
  try {
    await navigator.clipboard.writeText(claudeInstallCommand)
    toast(tl(`Command copied: paste it into a terminal on ${name}.`, `Commande copiée : colle-la dans un terminal de ${name}.`))
  } catch { toast(t('Copy failed'), true) }
}

// Declined or skipped: no more suggestion for these machines, on any device.
export async function dismissClaudeQuotas(keys: string[], dismissed = true): Promise<boolean> {
  if (!keys.length) return false
  try {
    await api('/api/claude-setup', { keys, dismissed })
    await reloadQuotas()
    return true
  } catch (err) {
    toast((err as Error).message, true)
    return false
  }
}

// Machines with Claude and their status line state (base machines only: a
// named session shares its machine's ~/.claude).
export const claudeSetupList = computed(() => {
  const ms = appConfig.value.machines?.filter(m => !machineInfo(m.key)?.baseKey)
    .map(m => ({ key: m.key, name: machineName(m.key) || m.label, online: m.local || machineInfo(m.key)?.status === 'online', kinds: m.kinds }))
    || [{ key: '', name: hostLabel.value || t('This machine'), online: true, kinds: appConfig.value.kinds }]
  return claudeSetupRows(homeQuotas.value, ms)
})
