import { describe, expect, it } from 'vitest'
import { listGroups, scriptProblems } from '../website/app/utils/demoScript'
import type { DemoAgent, DemoScript } from '../website/app/utils/demoScript'
import { ANSWER, HERO, actionsAt, agentState } from '../website/app/utils/heroDemo'
import { CATCHUP_MS, GLYPH_MS as SITE_GLYPH_MS, TRAIL_GLYPHS as SITE_TRAIL, trailGlyphs as siteGlyphs, typeDuration, typingFronts as siteFronts } from '../website/app/utils/typing'
import { GLYPH_MS as APP_GLYPH_MS, TRAIL_GLYPHS as APP_TRAIL, trailGlyphs as appGlyphs, typingFronts as appFronts } from '../app/utils/typewriter'
import { CONVERSATION, PHONE } from '../website/app/utils/storyDemos'

describe('live demos', () => {
  it.each([HERO, CONVERSATION, PHONE].map(s => [s.id, s] as const))('%s plays in order, inside its loop', (_, script) => {
    expect(scriptProblems(script)).toEqual([])
  })

  it('flags scripts that would play wrong', () => {
    const bad: DemoScript = { id: 'x', timeline: [[500, 1], [400, 3]], loop: 400, final: 4 }
    expect(scriptProblems(bad)).toEqual([
      'x: 400 ms is not after 500 ms',
      'x: step 3 follows step 1',
      'x: the last step is not before the loop end',
      'x: final step 4 is never reached',
    ])
    const slowTyping: DemoScript = { id: 'y', timeline: [[100, 1], [600, 2]], loop: 1000, final: 2, typing: { step: 1, text: 'abc', ms: 900 } }
    expect(scriptProblems(slowTyping)).toEqual(['y: typing runs past step 2'])
    expect(scriptProblems({ ...slowTyping, typing: { step: 3, text: 'abc', ms: 10 } })).toEqual(['y: typing step 3 is never reached'])
  })

  it('hero agent: ready, working once the message is read, your turn at the question, working once answered', () => {
    expect([0, 2, 3, 8, 9, 10, 11].map(agentState)).toEqual(['idle', 'idle', 'working', 'working', 'blocked', 'working', 'working'])
    expect(actionsAt(3)).toEqual([])
    expect(actionsAt(5).map(a => a.cmd)).toEqual(['read src/users.js', 'grep "getUser" src/'])
    expect(actionsAt(11)).toHaveLength(4)
  })

  it('hero answer finishes typing, at the app default speed, before the question shows', () => {
    const at = (s: number) => HERO.timeline.find(([, step]) => step === s)![0]
    const chars = ANSWER.replaceAll('`', '').length
    expect(typeDuration(chars, 'medium') + CATCHUP_MS.medium).toBeLessThanOrEqual(at(9) - at(8))
  })

  it('typing fronts and glyphs match the app typewriter', () => {
    for (const speed of ['off', 'fast', 'medium', 'slow'] as const) {
      for (const total of [0, 1, 39, 120, 900]) {
        for (let ms = -50; ms <= 7000; ms += 37) expect(siteFronts(total, ms, speed)).toEqual(appFronts(total, ms, speed))
      }
    }
    let n = 0
    const rand = () => (n = (n * 7 + 3) % 10) / 10
    const text = 'a b\n  {x}'
    const site = siteGlyphs(text, rand)
    n = 0
    expect(site).toEqual(appGlyphs(text, rand))
    expect([SITE_GLYPH_MS, SITE_TRAIL]).toEqual([APP_GLYPH_MS, APP_TRAIL])
  })
})

describe('compact agent list', () => {
  const agent = (name: string, state: DemoAgent['state']): DemoAgent => ({ name, state, agent: 'claude', model: 'Opus 5.5', line: '' })

  it('groups the other agents as the app does: your turn, working, ready (done and idle), no empty group', () => {
    const groups = listGroups([agent('a', 'idle'), agent('b', 'working'), agent('c', 'done')])
    expect(groups.map(g => [g.title, g.list.map(a => a.name)])).toEqual([['Working', ['b']], ['Ready', ['a', 'c']]])
  })
})
