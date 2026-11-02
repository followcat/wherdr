import { afterEach, expect, it, vi } from 'vitest'
import { useRouter } from '#app'
import { useViewBack } from '~/composables/useViewBack'

const original = history.state
afterEach(() => {
  history.replaceState(original, '')
  vi.restoreAllMocks()
})

// The header and browser share one stack: header must pop, never push or
// replace a valid predecessor, including after task/chat switches.
it.each(['/', '/board', '/board?machine=&task=demo%2F9', '/board?task=demo%2F9&view=chat', '/a/w1%3Ap1', '/t/w1%3At1'])(
  'header back traverses each internal predecessor: %s', back => {
    const router = useRouter()
    const pop = vi.spyOn(router, 'back').mockImplementation(() => {})
    const replace = vi.spyOn(router, 'replace').mockResolvedValue()
    const push = vi.spyOn(router, 'push').mockResolvedValue()
    history.replaceState({ back }, '')
    useViewBack()()
    expect(pop).toHaveBeenCalledOnce()
    expect(replace).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  },
)

it.each([null, {}, { back: null }, { back: '//example.org' }, { back: 'https://example.org' }])(
  'header back replaces an absent or external predecessor with Home: %j', state => {
    const router = useRouter()
    const pop = vi.spyOn(router, 'back').mockImplementation(() => {})
    const replace = vi.spyOn(router, 'replace').mockResolvedValue()
    history.replaceState(state, '')
    useViewBack()()
    expect(replace).toHaveBeenCalledExactlyOnceWith('/')
    expect(pop).not.toHaveBeenCalled()
  },
)
