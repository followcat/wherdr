// WHR-294: Home's Tasks to review card counts what waits for the user on the
// home tab's projects; a tap opens the review sheet, one task at a time: Approve
// (Accept, the next one shows), Reject (a note and screenshots back to the worker),
// the others' own answers, previous and next (a task passed over stays), the keys,
// All done after the last; its filter follows the group tab by default.
import { afterEach, expect, it, vi } from 'vitest'
import { createError, readBody } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ReviewCard from '~/components/ReviewCard.vue'
import { coordinators } from '~/composables/useCoordinators'
import { machineBarSaved, machineGroups } from '~/composables/useMachineBar'
import { reviewFilter, reviewOpen } from '~/composables/useReview'
import { lightboxSrc } from '~/composables/useUi'
import { toHandle, type Card } from '#shared/pm/board'

const plan = [{ id: 'work', holder: 'worker', ends: 'report' }, { id: 'review', holder: 'reviewer', ends: 'verdict' }, { id: 'merge', holder: 'user', ends: 'user', action: { kind: 'github.merge' } }]
const card = (id: string, project: string, over: Partial<Card> = {}): Card => ({
  id, shown: id, project, title: `Task ${id}`, description: '', column: 'Merge', phase: 'your-turn', holder: 'user', tags: [], log: [],
  links: [{ label: 'PR', url: `https://example.com/o/r/pull/${id.length}` }], plan: plan as Card['plan'], yourTurn: 'Merge', userLabel: 'Accept', tldr: `What ${id} changes.`,
  state: { at: 2, started: true, proofs: {}, rounds: { review: 1 }, yourTurn: { reason: 'user', badge: 'Merge' }, shots: { work: [{ file: 'aaaaaaaaaaaa.png', phase: 'after', at: 1 }] } },
  ...over,
})
let cards: Card[] = []
const accepted: string[] = []
registerEndpoint('/api/pm/board', () => ({ projects: [{ key: 'home', name: 'Home', columns: [], types: [] }, { key: 'work', name: 'Work', columns: [], types: [] }], cards }))
registerEndpoint('/api/pm/handle', () => toHandle(cards))
registerEndpoint('/api/pm/step-user', { method: 'POST', handler: async (e) => {
  const { id } = await readBody(e) as { id: string }
  if (id === 'HO-X') throw createError({ statusCode: 409, statusMessage: 'The PR has conflicts' })
  accepted.push(id)
  cards = cards.filter(c => c.id !== id)
  return { task: { id } }
} })
let sentBack: unknown
registerEndpoint('/api/pm/step-back', { method: 'POST', handler: async (e) => { sentBack = await readBody(e); return { task: {} } } })
afterEach(() => { reviewOpen.value = false; reviewFilter.value = null; accepted.length = 0 })

const sheet = () => document.querySelector('[data-testid="review-sheet"]')
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const shown = () => sheet()?.querySelector('[data-testid="review-item"]')?.getAttribute('data-task') ?? (q('review-done') ? 'done' : null)
const progress = () => q('review-progress')?.textContent

it('counts what waits on Home and reviews it one by one: Approve, Reject, the others\' own answers, previous, next and the keys', async () => {
  cards = [card('HO-1', 'home'), card('HO-2', 'home', { tldr: undefined, state: { at: 2, started: true, proofs: {}, rounds: {}, yourTurn: { reason: 'user', badge: 'Merge' } } }),
    card('HO-3', 'home', { yourTurn: 'Merge refused: conflict', state: { at: 2, started: true, proofs: {}, rounds: {}, yourTurn: { reason: 'action', badge: 'Merge refused: conflict' } } })]
  const w = await mountSuspended(ReviewCard)
  await expect.poll(() => w.find('[data-testid="review-count"]').exists() && w.find('[data-testid="review-count"]').text()).toBe('3')
  // The card names them: each id as its project's key badge.
  expect(w.findAll('[data-testid="review-ids"] [data-testid="project-badge"]').map(b => b.text())).toEqual(['HO-1', 'HO-2', 'HO-3'])
  await w.find('[data-testid="review-open"]').trigger('click')
  await expect.poll(shown).toBe('HO-1')
  // A task to approve: TL;DR, its screenshots, its PR and the verdict in one line.
  expect(sheet()!.querySelector('[data-testid="todo-tldr"]')?.textContent).toContain('What HO-1 changes.')
  expect(sheet()!.querySelectorAll('[data-testid="shot"]').length).toBe(1)
  expect([q('review-pr')?.textContent, q('review-verdict')?.textContent]).toEqual(['PR #4', 'Review passed, 1 send-back'])
  expect([progress(), q('review-skip')]).toEqual(['1 of 3', null]) // the arrows move on, no Skip

  q('review-next')!.click() // passed over, it stays
  await expect.poll(shown).toBe('HO-2')
  expect(q('shot')).toBeNull() // no screenshots
  q('review-prev')!.click()
  await expect.poll(shown).toBe('HO-1')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await expect.poll(shown).toBe('HO-2')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })) // A: approve
  await expect.poll(shown).toBe('HO-3') // it leaves the list, the next one shows
  expect(accepted).toEqual(['HO-2'])
  expect(progress()).toBe('2 of 2')
  // The screenshot viewer open over it keeps its keys: no next, no approve behind it.
  lightboxSrc.value = '/shot.png'
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  await new Promise(r => setTimeout(r, 50))
  expect([shown(), accepted.length]).toEqual(['HO-3', 1])
  lightboxSrc.value = null
  // Anything else that waits shows its To do answers: a failed merge, Try again.
  expect([q('review-approve'), !!q('task-todo'), q('review-answer')?.textContent]).toEqual([null, true, 'Open the task'])
  q('review-retry')!.click()
  await expect.poll(shown).toBe('done') // answered, read again: it left Your turn
  expect(accepted).toEqual(['HO-2', 'HO-3'])
  expect(q('review-done')!.textContent).toContain('1 passed over, still in the list.')
  q('review-restart')!.click()
  await expect.poll(shown).toBe('HO-1')

  // R: Reject, with a note and the screenshots that are wrong, back to its worker.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
  await expect.poll(() => !!q('review-reject')).toBe(true)
  const field = q('review-reject-note')!
  const note = (field.tagName === 'TEXTAREA' ? field : field.querySelector('textarea')!) as HTMLTextAreaElement
  note.value = 'The toggle is cut off'
  note.dispatchEvent(new Event('input'))
  q('task-report-shot')!.click()
  await expect.poll(() => q('review-reject-send')?.hasAttribute('disabled')).toBe(false)
  q('review-reject-send')!.click()
  await expect.poll(shown).toBe('done')
  expect(sentBack).toEqual({ id: 'HO-1', note: 'The toggle is cut off', shots: ['aaaaaaaaaaaa.png'] })
  expect(q('review-done')!.textContent).toContain('The engine takes over')
  w.unmount()
})

it('follows the group tab by default, and keeps the filter picked', async () => {
  coordinators.value = [{ project: 'home', name: 'Home', machines: ['laptop'] }, { project: 'work', name: 'Work', machines: ['office'] }]
  machineGroups.value = [{ id: '*group:personal', name: 'Personal', machines: ['laptop'] }, { id: '*group:work', name: 'Work', machines: ['office'] }]
  cards = [card('HO-1', 'home'), card('HO-2', 'home', { userLabel: 'Create these tasks', plan: [plan[0], { id: 'pick', holder: 'user', ends: 'user' }] as Card['plan'], state: { at: 1, started: true, proofs: {}, rounds: {}, yourTurn: { reason: 'user', badge: 'Pick the tasks' } } }), card('WK-1', 'work')]
  try {
    machineBarSaved.value = '*group:personal'
    reviewOpen.value = true
    const w = await mountSuspended(ReviewCard)
    await expect.poll(() => w.find('[data-testid="review-count"]').exists() && w.find('[data-testid="review-count"]').text()).toBe('2')
    await expect.poll(shown).toBe('HO-1')
    q('review-next')!.click()
    await expect.poll(shown).toBe('HO-2')
    // Another step of the user's keeps its own button: no Approve.
    expect([q('review-approve'), q('review-answer')?.textContent]).toEqual([null, 'Open the task'])
    machineBarSaved.value = '*group:work' // the tab changes from the second one: the sheet follows it, from its first
    await expect.poll(shown).toBe('WK-1')
    reviewFilter.value = 'p:home' // one project, kept like the Board's picker
    await expect.poll(shown).toBe('HO-1')
    reviewFilter.value = '*group:work' // one group, whatever the tab
    machineBarSaved.value = '*group:personal'
    await expect.poll(shown).toBe('WK-1')
    reviewFilter.value = 'all'
    await expect.poll(progress).toBe('1 of 3')
    w.unmount()
  } finally { coordinators.value = []; machineGroups.value = []; machineBarSaved.value = null }
})

it('confirms Approve, then slides to the next task; a failure stays put; reduced motion fades', async () => {
  cards = [card('HO-1', 'home'), card('HO-X', 'home'), card('HO-3', 'home')]
  reviewOpen.value = true
  const w = await mountSuspended(ReviewCard)
  await expect.poll(shown).toBe('HO-1')
  expect(q('review-stage')!.dataset.motion).toBe('slide')
  q('review-approve')!.click()
  // Approved on its button, the same task still there, then the next one.
  await expect.poll(() => q('review-approve')?.textContent).toBe('Approved')
  expect([shown(), progress()]).toEqual(['HO-1', '1 of 3'])
  await expect.poll(shown).toBe('HO-X')
  expect([progress(), q('review-approve')?.textContent]).toEqual(['1 of 2', 'Approve'])
  q('review-approve')!.click() // refused by the server: the error, the same task, no confirmation
  await expect.poll(() => !!q('review-error')).toBe(true)
  await new Promise(r => setTimeout(r, 500))
  expect([shown(), q('review-approve')?.textContent]).toEqual(['HO-X', 'Approve'])
  w.unmount()

  const mm = vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('reduced-motion'), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList)
  try {
    const r = await mountSuspended(ReviewCard)
    await expect.poll(() => q('review-stage')?.dataset.motion).toBe('fade')
    r.unmount()
  } finally { mm.mockRestore() }
})
