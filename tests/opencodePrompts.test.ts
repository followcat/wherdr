import { describe, expect, it } from 'vitest'
import { opencodeCard } from '../server/utils/opencodePrompts'

const perm = (over: Record<string, unknown> = {}) => ({ id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['git push origin main'], ...over })

describe('opencodeCard', () => {
 it('maps a permission request to a three-option card with request identity', () => {
  const card = opencodeCard({ permissions: [perm()], forms: [] })!
  expect(card).toBeTruthy()
  expect(card.choices.question).toBe('Allow bash?')
  expect(card.choices.options.map(o => o.label)).toEqual(['Allow once', 'Always allow', 'Reject'])
  expect(card.choices.detail).toMatchObject({ tool: 'bash', command: 'git push origin main' })
  expect(card.dispatch).toEqual({ kind: 'permission', id: 'per_1', decisions: ['once', 'always', 'reject'] })
 })

 it('uses the request message as the question and changes identity with content', () => {
  const a = opencodeCard({ permissions: [perm({ message: 'Run the tests?' })], forms: [] })!
  expect(a.choices.question).toBe('Run the tests?')
  const b = opencodeCard({ permissions: [perm({ message: 'Deploy now?' })], forms: [] })!
  expect(b.choices.identity).not.toBe(a.choices.identity)
  const c = opencodeCard({ permissions: [perm({ message: 'Run the tests?' })], forms: [] })!
  expect(c.choices.identity).toBe(a.choices.identity)
 })

 it('maps a boolean form field to a Yes/No card', () => {
  const form = { id: 'frm_1', sessionID: 'ses_1', title: 'Confirm', fields: [{ key: 'ok', type: 'boolean', title: 'Proceed?' }] }
  const card = opencodeCard({ permissions: [], forms: [form] })!
  expect(card.choices.question).toBe('Proceed?')
  expect(card.choices.options.map(o => o.label)).toEqual(['Yes', 'No'])
  expect(card.dispatch).toEqual({ kind: 'form', id: 'frm_1', key: 'ok', values: [true, false] })
 })

 it('maps a single-choice string field, adding a free option when custom is allowed', () => {
  const form = { id: 'frm_2', sessionID: 'ses_1', title: 'Pick', fields: [{ key: 'sel', type: 'string', title: 'Which?', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta', description: 'second' }] }] }
  const card = opencodeCard({ permissions: [], forms: [form] })!
  expect(card.choices.options.map(o => o.label)).toEqual(['Alpha', 'Beta'])
  expect(card.dispatch).toMatchObject({ kind: 'form', id: 'frm_2', key: 'sel', values: ['a', 'b'] })
  const custom = opencodeCard({ permissions: [], forms: [{ ...form, fields: [{ ...form.fields[0], custom: true }] }] })!
  expect(custom.choices.options.map(o => o.label)).toEqual(['Alpha', 'Beta', 'Type something.'])
  expect(custom.choices.options[2]!.free).toBe(true)
 })

 it('maps a plain string field to a free-text card and skips wider forms', () => {
  const free = { id: 'frm_3', sessionID: 'ses_1', title: 'Name it', fields: [{ key: 'name', type: 'string', title: 'Name?' }] }
  const card = opencodeCard({ permissions: [], forms: [free] })!
  expect(card.choices.options).toEqual([{ label: 'Type something.', hint: null, n: 1, free: true }])
  expect(card.dispatch).toMatchObject({ kind: 'form', id: 'frm_3', key: 'name' })
  // Multi-field, multiselect and number fields stay on the terminal.
  const multi = { id: 'frm_4', sessionID: 'ses_1', title: 'Two', fields: [{ key: 'a', type: 'boolean' }, { key: 'b', type: 'boolean' }] }
  const sel = { id: 'frm_5', sessionID: 'ses_1', title: 'Pick', fields: [{ key: 'x', type: 'multiselect', options: [{ value: 'v', label: 'V' }] }] }
  const num = { id: 'frm_6', sessionID: 'ses_1', title: 'Count', fields: [{ key: 'n', type: 'number' }] }
  expect(opencodeCard({ permissions: [], forms: [multi, sel, num] })).toBeNull()
 })

 it('prefers the first permission over any form and ignores malformed entries', () => {
  const form = { id: 'frm_1', sessionID: 'ses_1', title: 'Confirm', fields: [{ key: 'ok', type: 'boolean' }] }
  const card = opencodeCard({ permissions: [{ broken: true }, perm({ id: 'per_9' })], forms: [form] })!
  expect(card.dispatch).toMatchObject({ kind: 'permission', id: 'per_9' })
 })
})
