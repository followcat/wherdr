// References in the message field (Settings › Conversation, "Quoted replies").
// The draft text is the one of utils/questionReply.ts — each thing referred to
// as a "↳ … —" line (shared/reference.ts), its answer below — so sending, the
// draft kept per conversation and the "Quoted" buttons do not depend on the
// mode. Only the field's drawing differs:
//   native: the native textarea, its reference lines drawn as tokens by a
//           mirror behind it (utils/quoteMirror.ts), the default;
//   lines:  the plain field, the same lines as text: the fallback.

export const QUOTE_MODES = ['lines', 'native'] as const
export type QuoteMode = typeof QUOTE_MODES[number]

export const DEFAULT_QUOTE_MODE: QuoteMode = 'native'

// The mode is saved per device under one key. Earlier versions kept one value
// for the computer and one for the phone (and, before that, a switch each).
export const QUOTE_MODE_KEY = 'quoteMode'
export const OLD_QUOTE_MODE_KEYS = ['quoteModeComputer', 'quoteModePhone', 'quoteTokensComputer', 'quoteTokensPhone'] as const

// One pass per device, the first time the single key is missing or holds a
// mode that is gone: the mode becomes the default whatever the old keys held
// (a choice could not be told from the former default), and the old keys go.
// The key written here marks the pass as done, so a choice made afterwards is
// never overwritten.
export function migrateQuoteMode(store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): QuoteMode {
  const saved = store.getItem(QUOTE_MODE_KEY)
  if (QUOTE_MODES.includes(saved as QuoteMode)) return saved as QuoteMode
  for (const k of OLD_QUOTE_MODE_KEYS) store.removeItem(k)
  store.setItem(QUOTE_MODE_KEY, DEFAULT_QUOTE_MODE)
  return DEFAULT_QUOTE_MODE
}
