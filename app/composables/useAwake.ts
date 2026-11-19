// Keep a machine awake: its state per machine key (Settings › Machines cards and
// the machine tabs' menu read the same one) and the choices sheet.
import type { AwakeMode, AwakeRead, AwakeState } from '#shared/awake'
import { awakeRefusal, awakeWarning } from '#shared/awake'

export const awakeByMachine = ref<Record<string, AwakeState>>({})
// A tap under way per machine key (its read, or a menu choice being applied): the
// sun button spins, Home shows AwakePending, and a second tap does nothing.
export const awakeBusy = ref<Record<string, { label: string, what: 'read' | 'set' }>>({})

// A failed read is { error }: the machine did not answer, which is not "no tool".
export async function refreshAwake(key: string): Promise<AwakeRead> {
  try { return awakeByMachine.value[key] = await api<AwakeState>(`/api/machine/awake?key=${encodeURIComponent(key)}`) }
  catch (err) {
    delete awakeByMachine.value[key]
    return { error: (err as Error).message || 'no answer' }
  }
}

async function busy(key: string, label: string, what: 'read' | 'set', fn: () => Promise<void>) {
  if (awakeBusy.value[key]) return
  awakeBusy.value[key] = { label, what }
  try { await fn() }
  finally { delete awakeBusy.value[key] }
}

// "Awake until 18:00", "Awake until turned off", '' when it sleeps normally.
export function awakeLabel(s: AwakeState | undefined) {
  if (!s?.active) return ''
  return s.until ? tl(`Awake until ${fmtTime(s.until)}`) : t('Awake until turned off')
}

function choose(key: string, label: string, mode: AwakeMode | 'off') {
  return busy(key, label, 'set', async () => {
    try { awakeByMachine.value[key] = await api<AwakeState>('/api/machine/awake', { key, mode }) }
    catch (err) { toast(t((err as Error).message)) }
  })
}

export function openAwake(m: { key: string, label: string }) {
  haptic()
  return busy(m.key, m.label, 'read', async () => {
    const read = await refreshAwake(m.key)
    const refusal = t(awakeRefusal(m.label, read))
    if (refusal) {
      toast(refusal, 'error' in read, undefined, 'error' in read ? { label: t('Try again'), icon: 'i-lucide-rotate-cw', run: () => openAwake(m) } : undefined)
      return
    }
    showMenu(m, read as AwakeState)
  })
}

function showMenu(m: { key: string, label: string }, s: AwakeState) {
  const pick = (mode: AwakeMode | 'off') => () => choose(m.key, m.label, mode)
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
