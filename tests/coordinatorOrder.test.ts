import { expect, it } from 'vitest'
import { HIDDEN_MARK, dropSlots } from '../shared/pm/coordinatorOrder'

it('keeps a hidden coordinator shown while it needs the user hidden when others move (WHR-331)', () => {
  const prev = { order: ['AA', 'BB', 'CC'], hidden: ['BB'] }
  expect(dropSlots(['CC', 'AA', 'BB', HIDDEN_MARK], [], prev, ['BB'], 'CC')).toEqual({ order: ['CC', 'AA', 'BB'], hidden: ['BB'] })
  // Dragged itself into the main list: no longer hidden.
  expect(dropSlots(['BB', 'AA', 'CC', HIDDEN_MARK], [], prev, ['BB'], 'BB').hidden).toEqual([])
})
