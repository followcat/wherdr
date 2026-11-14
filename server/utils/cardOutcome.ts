// What the user did with a card in an agent's conversation (Apply, Cancel, a
// failed apply), told to that agent as a short message so it goes on by itself:
// typed into its terminal when it runs, else kept for its next start's first message.
import { cardNote } from '../../shared/uiActions'
import type { CoreAdminDeps } from './coreCreate'
import { noteTurn } from './pmCoordinator'
import type { CoordinatorRecord, PmStore } from './pmStore'

export const CARD_NOTES_KEPT = 20

export async function tellCardOutcome(deps: Pick<CoreAdminDeps, 'call'> & { store: PmStore }, key: string, outcome: string) {
  const c = await deps.store.coordinator(key)
  if (!c) return
  const text = cardNote(outcome)
  const live = !!c.terminal && await deps.call<{ state?: string }>('terminal.get', { terminal: c.terminal }, 3000).then(s => !!s && s.state !== 'finished', () => false)
  if (live) {
    try {
      await deps.call('terminal.send', { terminal: c.terminal, text }, 30000)
      // Its turn now follows the user's click: it may propose the next card.
      await noteTurn(deps.store, key, 'user', text)
      return
    }
    catch {}
  }
  const fresh = (await deps.store.coordinator(key))!
  await deps.store.saveCoordinator({ ...fresh, cardNotes: [...(fresh.cardNotes ?? []), outcome].slice(-CARD_NOTES_KEPT) })
}

// The next start's first message: what the user did with its cards since
// (startCoordinator drops them once it runs).
export const cardNotesMessage = (c?: Pick<CoordinatorRecord, 'cardNotes'> | null) =>
  c?.cardNotes?.length ? [cardNote(`since your last conversation, on your cards: ${c.cardNotes.join('; ')}`)] : []
