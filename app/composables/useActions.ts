// Agent actions shared between the list and the agent view.
import type { CloseProcess } from '#shared/closeProcess'
import { paneCloseConfirm } from '~/utils/spaceConfirm'
import type { Pane, QueuedMessage } from '#shared/types'
import { viaPrompt } from '#shared/sendRoute'
import { pasteRanges, splitPasted } from '#shared/pastedText'
import { sentPastes } from '~/utils/sentPastes'

// Choose an option of a blocking prompt (the server re-checks the screen).
// Free-answer option (`free`): with its text, typed by the server, and the
// question shown ("Other" has the same label for every question).
export async function choose(paneId: string, index: number, label: string, identity: string | undefined, free?: { text: string, question: string | null }): Promise<boolean> {
  haptic()
  try {
    await api('/api/choose', { pane_id: paneId, index, label, identity, ...free })
    const said = free && free.text.replace(/\s+/g, ' ').slice(0, 60)
    toast(`✓ ${said ? tl(`“${said}”`, `« ${said} »`) : label}`)
    return true
  } catch (err) {
    toast((err as Error).message, true)
    return false
  }
}

// Computer keyboard on a "Your turn" card: a real key to the terminal. With
// the question's identity, the server first checks that it is still on screen
// (see coreNav); ← → only on omp's "Ask" box with tabs.
// Keys sent one after the other, in typing order.
let navChain: Promise<unknown> = Promise.resolve()
export function navKey(paneId: string, key: 'up' | 'down' | 'enter' | 'esc' | 'left' | 'right', identity?: string): Promise<boolean> {
  const run = navChain.then(async () => {
    try {
      await api('/api/input', { pane_id: paneId, keys: [key], ...(identity ? { identity } : {}) })
      return true
    } catch (err) {
      toast((err as Error).message, true)
      return false
    }
  })
  navChain = run
  return run
}

// Send a message to an agent (input field, Run command): as a message, held
// by the server while a menu or dialog hides the input field, or typed as the
// answer to the question on screen (see viaPrompt). Working agent: the server
// queues the message (returned in `queued`).
// `clientId`: id of the bubble already shown for it (see utils/outbox.ts); the
// server keeps it for its record, so the bubble never changes identity.
// `pastes`: where the texts this device pasted into the field sit in the
// message, so that every device shows them as cards (see shared/pastedText.ts).
// `signal`: aborts the request (the outbox's deadline).
export async function sendMessage(p: Pane | undefined, paneId: string, text: string, clientId?: string, signal?: AbortSignal): Promise<QueuedMessage | null> {
  const pastes = pasteRanges(text, splitPasted(text, [], sentPastes.value).pastes)
  const r = viaPrompt(p)
    ? await api<{ queued?: QueuedMessage }>('/api/prompt', { pane_id: paneId, text, ...(clientId ? { client_id: clientId } : {}), ...(pastes.length ? { pastes } : {}) }, signal)
    : await api<{ queued?: QueuedMessage }>('/api/input', { pane_id: paneId, text, keys: ['enter'], ...(p?.prompt ? { native: true, identity: p.prompt.identity } : {}) }, signal)
  return r.queued || null
}

export const STATUS: Record<string, { label: string, order: number }> = {
  blocked: { label: 'Your turn', order: 0 },
  done: { label: 'Done', order: 1 },
  working: { label: 'Working', order: 2 },
  idle: { label: 'Ready', order: 3 },
  unknown: { label: 'Unknown', order: 4 },
}

// herdr-core: a terminal without a status reads as the home lists it (#320): an agent is
// Ready, a plain shell has no state.
const unknownCore = (p: Pane) => Boolean(p.coreAddress) && (!p.status || p.status === 'unknown')
export function statusKey(p: Pane) {
  if (unknownCore(p)) return p.agent ? 'idle' : 'shell'
  return (p.coreAddress || p.agent) ? p.status || 'unknown' : 'shell'
}
export function statusLabel(p: Pane) {
  if (!p.agent && !p.coreAddress) return 'Shell'
  const s = statusKey(p)
  if (s === 'shell') return ''
  return t((STATUS[s] || STATUS.unknown!).label)
}

export async function closePane(p: Pane) {
  // herdr-core does not say what runs in a pane: the warning stays conditional.
  const process: CloseProcess = { state: 'unknown' }
  // Written from the state at the time it is shown (asked again if it grew).
  const plan = await confirmClose('pane', p.id, (plan) => {
    const s = herdrState.value
    const pane = s.panes.find(x => x.id === p.id) || p
    const tab = s.tabs?.find(x => x.id === pane.tab)
    const workspace = s.workspaces.find(w => w.id === pane.workspace)
    return paneCloseConfirm({
      pane, process,
      tabLabel: tab ? (tab.label || String(tab.number)) : pane.tabLabel || '',
      tabPanes: s.panes.filter(x => x.tab === pane.tab).length,
      workspaceTabs: new Set(s.panes.filter(x => x.workspace === pane.workspace).map(x => x.tab)).size,
      workspaceLabel: workspace?.label || paneTitle(pane),
      closesTab: plan.tabs.includes(pane.tab),
      closesWorkspace: plan.closesWorkspace,
    }, tl)
  })
  if (!plan) return
  // Closed from its view: its tab if panes remain there, otherwise the neighbouring
  // tab, otherwise the list. Closed from the plan: we stay there.
  const done = prepareClose({ pane: p.id })
  try {
    await api('/api/close', { pane_id: p.id })
    toast(t('Pane closed'))
    done(true)
  } catch (err) {
    done(false)
    toast((err as Error).message, true)
  }
}
