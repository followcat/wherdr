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
  const resources = strs(req.resources)
  const message = str(req.message, 400)
  const options: ChoiceOption[] = ['Allow once', 'Always allow', 'Reject'].map((label, i) => ({ label, hint: null, n: i + 1 }))
  const choices: Choices = {
    question: message || `Allow ${req.action}?`,
    cursor: 0,
    options,
    detail: { tool: str(req.action, 60) || 'tool', ...(resources.length ? { command: resources.join('\n') } : {}) },
    identity: identity({ oc: 'permission', id: req.id, action: req.action, resources, save: strs(req.save), message }),
  }
  return { choices, dispatch: { kind: 'permission', id: req.id, decisions: ['once', 'always', 'reject'] } }
}

// A form becomes a card only when it asks one thing we can fully answer:
// a boolean, a single choice (its options, a custom answer when allowed),
// or a free-text field. Anything wider stays on the terminal.
function formChoices(form: Json): OcCard | null {
  if (typeof form?.id !== 'string') return null
  const fields = (Array.isArray(form.fields) ? form.fields : []).filter(f => f && !f.hidden)
  if (fields.length !== 1) return null
  const f = fields[0]
  const key = typeof f.key === 'string' ? f.key : ''
  if (!key) return null
  const question = str(f.title, 300) || str(form.title, 300) || 'Answer?'
  const hint = str(f.description, 300) || null
  let options: ChoiceOption[]
  let values: (string | boolean)[]
  if (f.type === 'boolean') {
    options = [{ label: 'Yes', hint, n: 1 }, { label: 'No', hint: null, n: 2 }]
    values = [true, false]
  } else if (f.type === 'string' && Array.isArray(f.options) && f.options.length) {
    options = f.options.slice(0, 12).map((o: Json, i: number) => ({ label: str(o?.label || o?.value, 200) || '?', hint: str(o?.description, 300) || null, n: i + 1 }))
    values = f.options.slice(0, 12).map((o: Json) => str(o?.value, 200))
    if (f.custom) options.push({ label: 'Type something.', hint: null, n: options.length + 1, free: true })
  } else if (f.type === 'string') {
    options = [{ label: 'Type something.', hint, n: 1, free: true }]
    values = []
  } else return null
  const choices: Choices = {
    question,
    cursor: 0,
    options,
    identity: identity({ oc: 'form', id: form.id, key, question, options: options.map(({ label, hint: h, free }) => ({ label, hint: h, free })) }),
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
