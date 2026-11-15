// WHR-333: a task back to review after its approval says why on top: the
// worker's reason (a task it names opens), else the engine's files and commits.
import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import LookAgainBanner from '~/components/LookAgainBanner.vue'

it('shows the worker\'s reason with the task it names, else what the engine saw', async () => {
  const why = 'the interface changed since your approval (fcd4bfd..a1314a2) in app/assets/main.css'
  const w = await mountSuspended(LookAgainBanner, { props: { look: { why, at: 1, reason: 'the merge found a conflict with WHR-645, which touches the same screen' } } })
  expect(w.text()).toContain('Back to review because: the merge found a conflict with WHR-645, which touches the same screen')
  expect(w.text()).toContain('See the new screenshots before you approve.')
  await w.find('[data-testid="look-again-task"]').trigger('click')
  await expect.poll(() => useRouter().currentRoute.value.query.task).toBe('WHR-645')
  await w.setProps({ look: { why, at: 1 } })
  expect(w.text()).toContain(`Back to review because: ${why}`)
  expect(w.find('[data-testid="look-again-task"]').exists()).toBe(false)
}, 60_000) // a mount can take 20 s on a busy machine
