import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { isAppLink } from '../shared/appLinks'
import { UI_TARGETS, uiTarget, uiTargetLink, type UiTargetId } from '../shared/uiTargets'
import { uiPlaceLabel } from '../shared/uiOpen'
import { docsRule } from '../shared/pm/coordinator'

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.(vue|ts)$/.test(e.name) ? [join(dir, e.name)] : [])

// A renamed or moved setting fails here, not for the user.
it('marks each registry target exactly once in app/, and nothing outside the registry', () => {
  const marks = files('app').flatMap(f => [...readFileSync(f, 'utf8').matchAll(/data-ui-target="([^"$]+)"/g)].map(m => m[1]))
  const ids = Object.keys(UI_TARGETS)
  expect([...marks].sort()).toEqual([...ids].sort())
})

it('links each target to its section with a target parameter, named on the card', () => {
  for (const id of Object.keys(UI_TARGETS) as UiTargetId[]) {
    const link = uiTargetLink(id)
    expect(isAppLink(link), link).toBe(true)
    expect(link.startsWith(`${UI_TARGETS[id].link}&`)).toBe(true)
  }
  expect(uiTargetLink('conversation.reply-style')).toBe('#/settings?section=conversation&tab=display&target=conversation.reply-style')
  expect(uiPlaceLabel(uiTargetLink('phone.app-start'))).toBe('Settings › Phone › App start')
  expect(uiTarget('toString')).toBeNull()
  expect(uiTarget('nope')).toBeNull()
})

it('lists every target in the agents\' role text, with the commands that use them', () => {
  const text = docsRule(undefined, 'help', { cmd: 'wherdr pm ui open', places: 'places' }, []).join('\n')
  expect(text).toContain('`wherdr pm ui open --target <id>`')
  expect(text).toContain('`wherdr pm ui targets`')
  for (const id of Object.keys(UI_TARGETS)) expect(text).toContain(`${id} (`)
})
