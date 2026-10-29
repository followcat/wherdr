import { expect, it } from 'vitest'
import { hasOlder, olderCursor, restartsTail, tailQuery } from '../app/utils/chatTail'

it('keeps opaque older-page boundaries separate from the refreshed tail anchor', () => {
  expect(olderCursor({ start: 'tail-anchor', olderCursor: 'page+cursor/=' })).toBe('page+cursor/=')
  expect(olderCursor({ olderCursor: null, start: 'tail-anchor' })).toBeNull()
  expect(olderCursor({ olderCursor: 'page', start: 'tail' }, 'page')).toBeNull()
  expect(hasOlder('page')).toBe(true)
  expect(hasOlder(null)).toBe(false)
  expect(restartsTail({ file: 'session', tailStart: 'tail' }, { file: 'session', start: 'tail' })).toBe(false)
  expect(restartsTail({ file: 'session', tailStart: 'tail' }, { file: 'session', start: 'new-tail' })).toBe(true)
  expect(tailQuery('p1', { token: 'token', tailStart: 'tail+anchor/=', tail: [] }).get('from')).toBe('tail+anchor/=')
})

it('preserves numeric pagination semantics for existing file readers', () => {
  expect(olderCursor({ start: 200 })).toBe(200)
  expect(olderCursor({ start: 100 }, 200)).toBe(100)
  expect(olderCursor({ start: 200 }, 100)).toBeNull()
  expect(olderCursor({ start: 0 }, 100)).toBeNull()
  expect(hasOlder(0)).toBe(false)
})
