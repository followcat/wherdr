// WHR-467: a `questions` card: one pick per question (or the user's own
// words, or a key), then one Send for all; once answered, the reply shown.
import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import QuestionsCard from '~/components/QuestionsCard.vue'

const items = [
  { q: 'Which database?', options: ['Postgres', 'SQLite'] },
  { q: 'Keep the old API?', options: ['Yes', 'No, remove it'] },
  { q: 'Name it?', options: ['core', 'base'] },
]

it('picks one answer per question, by tap, key or words, and sends them in one message', async () => {
  const w = await mountSuspended(QuestionsCard, { attachTo: document.body, props: { items, live: true, given: null } })
  const send = () => w.find<HTMLButtonElement>('[data-testid="questions-send"]')
  expect(send().element.disabled).toBe(true)

  await w.find('[data-testid="questions-opt-0-1"]').trigger('click')
  await w.find('[data-testid="questions-opt-0-0"]').trigger('click') // another pick replaces it
  expect(w.find('[data-testid="questions-opt-0-0"]').attributes('aria-pressed')).toBe('true')
  expect(w.text()).toContain('2 unanswered, sent as skip')
  await w.find('[data-testid="questions-opt-1-0"]').trigger('keydown', { key: 'b' })
  await w.find('[data-testid="questions-other-2"]').trigger('click')
  await w.find('input').setValue('kernel')
  await send().trigger('click')

  expect(w.emitted('send')).toEqual([['1A Postgres\n2B No, remove it\n3 kernel']])
  expect(send().exists()).toBe(false) // no second Send
  w.unmount()
})

it('shows the reply given, greyed, with what was skipped', async () => {
  const w = await mountSuspended(QuestionsCard, { props: { items, live: false, given: '1B SQLite\n2 skip\n3 kernel' } })
  expect(w.find('[data-testid="questions-opt-0-1"]').attributes('aria-pressed')).toBe('true')
  expect(w.findAll('button:disabled').length).toBe(6)
  expect(w.text()).toContain('skip')
  expect(w.text()).toContain('↳ kernel')
  expect(w.find('[data-testid="questions-send"]').exists()).toBe(false)
})
