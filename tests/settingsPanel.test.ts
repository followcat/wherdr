import { expect, it } from 'vitest'
import { uiOpenPanel } from '../app/utils/settingsPanel'

// The AgentView wiring is in tests/components/UiOpen.test.ts; here, the links.
const chat = { path: '/a/w1:p1', query: {} }

it('keeps a Settings link\'s sub-place in the panel, and leaves other places to the card', () => {
  expect(uiOpenPanel('#/settings?section=projects&project=WEB', chat, true))
    .toEqual({ path: '/a/w1:p1', query: { section: 'projects', project: 'WEB' } })
  expect(uiOpenPanel('#/decisions', chat, true)).toBeNull()
})
