import { describe, expect, it, vi } from 'vitest'
import { MAIN } from '../shared/pm/coordinator'
import type { UiCard } from '../shared/uiActions'

const { actOnCard, addChangeCard } = await import('../server/utils/uiActions')
const { cardNotesMessage } = await import('../server/utils/cardOutcome')

const change = { argv: ['project', 'guards', 'WEB'], lines: ['guards: merge → user'], project: 'WEB' }

// Alfred's record, its terminal running or not; what wherdr types into it.
function setup(running: boolean) {
  const rec = { project: MAIN, tokenHash: '', terminal: 'term-1' } as { project: string, tokenHash: string, terminal: string, cards?: UiCard[], cardNotes?: string[], turn?: { kind: string } }
  const store = { coordinator: async () => rec, coordinators: async () => [rec], saveCoordinator: async (r: typeof rec) => { Object.keys(rec).forEach(k => delete (rec as never)[k]); Object.assign(rec, r) } }
  const sent: string[] = []
  const call = vi.fn(async (method: string, p: { text?: string }) => {
    if (method === 'terminal.get') return { state: running ? 'running' : 'finished' }
    if (method === 'terminal.send') sent.push(p.text!)
    return {}
  })
  const card = async () => {
    await addChangeCard(store as never, { turn: 'user', by: 'Alfred', change, label: 'Project WEB › Guards' })
    return rec.cards![0]!.id
  }
  return { rec, sent, card, deps: (applyChange: (a: string[], l: string[]) => Promise<string[] | null>) => ({ store, call, applyChange }) as never }
}

describe('a card\'s outcome told to its agent', () => {
  it('Apply sends one message, and its turn follows the user', async () => {
    const { rec, sent, card, deps } = setup(true)
    const id = await card()
    await actOnCard(deps(async () => []), id, undefined)
    await actOnCard(deps(async () => []), id, undefined) // a second click changes nothing
    expect(sent).toEqual(['From the card: Applied: Project WEB › Guards'])
    expect(rec.turn?.kind).toBe('user')
  })

  it('Cancel sends one message', async () => {
    const { sent, card, deps } = setup(true)
    await actOnCard(deps(async () => []), await card(), undefined, true)
    expect(sent).toEqual(['From the card: Cancelled: Project WEB › Guards'])
  })

  it('a failed or stale apply says it was not applied, and why', async () => {
    const { sent, card, deps } = setup(true)
    await actOnCard(deps(async () => null), await card(), undefined)
    await expect(actOnCard(deps(async () => { throw new (await import('../server/utils/herdr')).HerdrError('refused', 'Not a git repository') }), await card(), undefined)).rejects.toThrow(/git/)
    expect(sent).toEqual([
      'From the card: Not applied: Project WEB › Guards: this changed since, nothing was applied',
      'From the card: Not applied: Project WEB › Guards: Not a git repository',
    ])
  })

  it('sends nothing while the agent does not run: its next start says it', async () => {
    const { rec, sent, card, deps } = setup(false)
    await actOnCard(deps(async () => []), await card(), undefined)
    expect(sent).toEqual([])
    expect(cardNotesMessage(rec)).toEqual(['From the card: since your last conversation, on your cards: Applied: Project WEB › Guards'])
  })
})
