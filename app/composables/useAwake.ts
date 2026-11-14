// Keep a machine awake: its state per machine key (Settings › Machines cards and
// the machine tabs' menu read the same one) and the choices sheet.
import type { AwakeMode, AwakeState } from '#shared/awake'
import { awakeWarning } from '#shared/awake'

export const awakeByMachine = ref<Record<string, AwakeState>>({})

export async function refreshAwake(key: string) {
  try { awakeByMachine.value[key] = await api<AwakeState>(`/api/machine/awake?key=${encodeURIComponent(key)}`) }
  catch { delete awakeByMachine.value[key] }
  return awakeByMachine.value[key]
}

// "Awake until 18:00", "Awake until turned off", '' when it sleeps normally.
export function awakeLabel(s: AwakeState | undefined) {
  if (!s?.active) return ''
  return s.until ? tl(`Awake until ${fmtTime(s.until)}`) : t('Awake until turned off')
}

async function choose(key: string, mode: AwakeMode | 'off') {
  try { awakeByMachine.value[key] = await api<AwakeState>('/api/machine/awake', { key, mode }) }
  catch (err) { toast(t((err as Error).message)) }
}

export async function openAwake(m: { key: string, label: string }) {
  haptic()
  const s = await refreshAwake(m.key)
  if (!s?.supported) { toast(t('Sleep control is not available on this machine')); return }
  const pick = (mode: AwakeMode | 'off') => () => choose(m.key, mode)
  const notes = [
    awakeLabel(s) || t('Normal sleep'),
    s.battery && tl(`Battery ${s.battery.percent}%${s.battery.source === 'ac' ? ' · power adapter' : ''}`),
    awakeWarning(s) && t(awakeWarning(s)),
  ].filter(Boolean) as string[]
  const items: MenuItem[] = [
    ...notes.map(label => ({ kind: 'note' as const, label })),
    ...(s.active && s.until ? [{ label: t('Extend by one hour'), icon: 'i-lucide-plus', desc: tl(`Until ${fmtTime(s.until + 3600_000)}`), run: pick('extend') }] : []),
    { label: t('1 hour'), icon: 'i-lucide-sun', run: pick('hour') },
    { label: t('4 hours'), icon: 'i-lucide-sun', run: pick('fourHours') },
    { label: t('Until this evening (8 pm)'), icon: 'i-lucide-sunset', disabled: s.eveningPast, desc: s.eveningPast ? t('It is already past 8 pm on this machine') : undefined, run: pick('evening') },
    { label: t('Until turned off'), icon: 'i-lucide-infinity', run: pick('untilOff') },
    ...(s.active ? [{ kind: 'separator' as const }, { label: t('Turn off'), icon: 'i-lucide-moon', run: pick('off') }] : []),
  ]
  openMenu(items, m.label ? tl(`Keep ${m.label} awake`) : t('Keep this machine awake'))
}
