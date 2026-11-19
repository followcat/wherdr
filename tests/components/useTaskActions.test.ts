// WHR-435: a step's busy state belongs to the task it was pressed on: moving on
// shows the next task's own state, coming back shows the first one's, and none
// is left once the board moved its step on or it left the list.
import { expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { readBody } from 'h3'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { useTaskActions } from '~/composables/useTaskActions'
import type { Card } from '#shared/pm/board'

const card = (id: string, at = 2): Card => ({ id, shown: id, project: 'p', title: id, description: '', column: 'Merge', phase: 'your-turn', holder: 'user', tags: [], log: [], links: [], plan: [],
  yourTurn: 'Check', userLabel: 'Check if merged', state: { at, started: true, proofs: {}, rounds: {} } } as Card)
const held: Record<string, () => void> = {}
registerEndpoint('/api/pm/step-user', { method: 'POST', handler: e => new Promise((r) => { void readBody(e).then((b: { id: string }) => { held[b.id] = () => r({ task: { id: b.id } }) }) }) })

it('keeps busy on the task pressed, not the one shown next; the board moving its step on ends it', async () => {
  const shown = ref<Card | undefined>(card('A'))
  const changed: string[] = []
  const a = effectScope().run(() => useTaskActions(() => shown.value, id => changed.push(id)))!
  const pressed = a.press()
  expect([a.busy.value, a.pressing.value]).toEqual([true, true])
  shown.value = card('B') // moved on with ›
  expect([a.busy.value, a.pressing.value]).toEqual([false, false])
  shown.value = card('A') // back on A, still pending
  expect([a.busy.value, a.pressing.value]).toEqual([true, true])
  // A leaves the list: nothing shows busy anywhere.
  a.forget('A')
  expect(a.busy.value).toBe(false)
  shown.value = card('B')
  await expect.poll(() => !!held.A).toBe(true)
  held.A!()
  await pressed
  expect([a.busy.value, changed]).toEqual([false, ['A']])

  // Pending while the board shows the step done: the board is the truth.
  shown.value = card('C')
  void a.press()
  expect(a.busy.value).toBe(true)
  shown.value = card('C', 3)
  await nextTick()
  expect([a.busy.value, a.pressing.value]).toEqual([false, false])
})
