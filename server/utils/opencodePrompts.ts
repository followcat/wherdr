// OpenCode's pending permission requests and unanswered forms, folded into
// the Choices shape its "Your turn" card already renders. The identity hash
// is over the request's own content, so an answer is refused the moment the
// request changed under it — the same contract screen prompts keep.
import { createHash } from 'node:crypto'
import type { ChoiceOption, Choices } from '../../shared/types'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export interface OcPending { permissions: Json[], forms: Json[] }
export type OcDispatch =
  | { kind: 'permission', id: string, decisions: string[] }
  | { kind: 'form', id: string, key: string, values: (string | boolean)[] }
export interface OcCard { choices: Choices, dispatch: OcDispatch }

const identity = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const str = (v: unknown, max = 1000) => typeof v === 'string' ? v.slice(0, max) : ''
const strs = (v: unknown, max = 8) => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, max) as string[] : []

// A permission request: action + the resources it wants, e.g.
// "Allow bash?" over "git push origin main".
function permissionChoices(req: Json): OcCard | null {
  if (typeof req?.id !== 'string' || typeof req?.action !== 'string') return null
  // Approving covers every resource the request lists, not just the first
  // rows the card has room for — the identity hashes the full list and the
  // detail admits how many more there are.
  const all = strs(req.resources, 64)
  const resources = all.slice(0, 8)
  const more = all.length - resources.length
  const message = str(req.message, 400)
  const options: ChoiceOption[] = ['Allow once', 'Always allow', 'Reject'].map((label, i) => ({ label, hint: null, n: i + 1 }))
  const choices: Choices = {
    question: message || `Allow ${req.action}?`,
    cursor: 0,
    // The dialog under this card moves with ⇆ — arrows are left/right.
    horizontal: true,
    options,
    detail: { tool: str(req.action, 60) || 'tool', ...(resources.length ? { command: resources.join('\n') + (more ? `\n… ${more} more` : '') } : {}) },
    identity: identity({ oc: 'permission', id: req.id, session: str(req.sessionID, 80), action: req.action, resources: all, save: strs(req.save, 64), message }),
  }
  return { choices, dispatch: { kind: 'permission', id: req.id, decisions: ['once', 'always', 'reject'] } }
}

// A form becomes a card only when it asks one thing we can fully answer:
// a boolean, a single choice (its options, a custom answer when allowed),
// or a free-text field. Anything wider stays on the terminal.
function formChoices(form: Json): OcCard | null {
  if (typeof form?.id !== 'string') return null
  const raw = Array.isArray(form.fields) ? form.fields : []
  // A hidden or conditional field the card cannot answer stays on the
  // terminal: submitting without it fails the service's own validation.
  if (raw.length !== 1 || raw.some((f: Json) => f?.hidden)) return null
  const f = raw[0]
  // The transport validates the same pattern before posting a reply — a
  // key it would refuse must not become a card in the first place.
  const key = typeof f.key === 'string' && /^[\w.-]{1,128}$/.test(f.key) ? f.key : ''
  if (!key || f.when) return null
  const question = str(f.title, 300) || str(form.title, 300) || 'Answer?'
  const hint = str(f.description, 300) || null
  let options: ChoiceOption[]
  let values: (string | boolean)[]
  if (f.type === 'boolean') {
    options = [{ label: 'Yes', hint, n: 1 }, { label: 'No', hint: null, n: 2 }]
    values = [true, false]
  } else if (f.type === 'string' && Array.isArray(f.options) && f.options.length) {
    options = f.options.slice(0, 12).map((o: Json, i: number) => ({ label: str(o?.label || o?.value, 200) || '?', hint: str(o?.description, 300) || null, n: i + 1 }))
    // The label is clipped for display; the submitted value is not —
    // the service validates it against the full option list.
    values = f.options.slice(0, 12).map((o: Json) => str(o?.value, 8000))
    if (f.custom) options.push({ label: 'Type something.', hint: null, n: options.length + 1, free: true })
  } else if (f.type === 'string') {
    options = [{ label: 'Type something.', hint, n: 1, free: true }]
    values = []
  } else return null
  const choices: Choices = {
    question,
    cursor: 0,
    options,
    // Values and the session are identity too: a form recreated with the
    // same labels but different choices must not take the old card's pick.
    identity: identity({ oc: 'form', id: form.id, session: str(form.sessionID, 80), key, question, values, options: options.map(({ label, hint: h, free }) => ({ label, hint: h, free })) }),
  }
  return { choices, dispatch: { kind: 'form', id: form.id, key, values } }
}

// The card to show: the oldest pending permission wins, then the first
// form simple enough to answer from the card.
export function opencodeCard(pending: OcPending): OcCard | null {
  for (const req of pending.permissions) {
    const card = permissionChoices(req)
    if (card) return card
  }
  for (const form of pending.forms) {
    const card = formChoices(form)
    if (card) return card
  }
  return null
}
