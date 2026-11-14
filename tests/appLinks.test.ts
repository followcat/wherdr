// WHR-44: the in-app addresses an agent gives, and how a chat message tells one.
import { expect, it } from 'vitest'
import { appLinkList, boardLink, CONVERSATION_TABS, isAppLink, projectLink, SETTINGS_SECTIONS, settingsLink } from '../shared/appLinks'
import { PROJECT_TABS } from '../shared/pm/places'

it('tells a whole in-app address from anything else', () => {
  for (const s of ['#/', '#/decisions', '#/board?project=CO&tag=ui', '#/settings?section=projects&project=CO&tab=guards', '#/a/w1:p1'])
    expect(isAppLink(s), s).toBe(true)
  for (const s of ['#heading', '#/board extra', 'see #/board', 'https://example.com/#/board', '#/board?x="y"', '#/<b>', 'wherdr:/board', '/board'])
    expect(isAppLink(s), s).toBe(false)
})

it('builds each address, and lists only addresses the app reads', () => {
  expect(settingsLink('phone')).toBe('#/settings?section=phone')
  expect(boardLink({ project: 'co', tag: 'ui' })).toBe('#/board?project=CO&tag=ui')
  expect(boardLink({ task: 'CO-1' })).toBe('#/board?task=CO-1')
  expect(projectLink('co', 'autopilot')).toBe('#/settings?section=projects&project=CO&tab=autopilot')
  const list = appLinkList().join('\n')
  const quoted = [...list.matchAll(/`([^`]+)`/g)].map(m => m[1]!.replace(/<\w+>/, 'x'))
  expect(quoted.length).toBeGreaterThanOrEqual(8)
  for (const q of quoted) expect(isAppLink(q), q).toBe(true)
  for (const s of [...SETTINGS_SECTIONS, ...PROJECT_TABS, ...CONVERSATION_TABS]) expect(list).toContain(s)
})
