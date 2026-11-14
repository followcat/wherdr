// WHR-75: every place a refusal or a role text sends the user to exists: a
// Settings section, a project sheet tab, and its in-app address agrees with it.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { guardAction } from '../shared/pm/actions'
import { alfredFiles } from '../shared/pm/alfred'
import { combineGuards } from '../shared/pm/guards'
import { roleFiles, templateEditRefusal } from '../shared/pm/coordinator'
import { PROJECT_TAB_LABEL, PROJECT_TABS } from '../shared/pm/places'
import type { Template } from '../shared/pm/workflow'
import { SETTINGS_SECTIONS } from '../app/utils/settingsNav'

const t: Template = { id: 'co', guards: { protected: ['main'] }, taskTypes: { feature: { steps: [{ id: 'work', holder: 'worker', ends: 'report' }] } } }
const p = { key: 'CO', name: 'Company', machine: '', path: '~/project', addedAt: 1 }
// The files whose literal texts name a place, the comments left out.
const SOURCES = ['shared/pm/actions.ts', 'shared/pm/coordinator.ts', 'shared/pm/alfred.ts', 'server/utils/pmCoordinator.ts', 'server/utils/pmProject.ts', 'server/utils/pmLaunch.ts', 'server/utils/alfredCli.ts']
const literal = SOURCES.flatMap(f => readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)))

const texts = [
  templateEditRefusal(null, t, 'user', 'CO'),
  templateEditRefusal(t, { ...t, guards: {} }, 'user', 'CO'),
  guardAction(combineGuards([]), { kind: 'github.pr' }, { branch: 'task/CO-1', by: 'engine', project: 'CO' }),
  guardAction(combineGuards([]), { kind: 'github.pr' }, { branch: 'task/CO-1', by: 'engine' }),
  ...Object.values(roleFiles(p, t, [])),
  ...Object.values(alfredFiles({ home: '~/alfred', version: '3.0.0', docs: '~/wherdr/docs', docFiles: [], pm: false, projects: [], address: { local: 'http://127.0.0.1:7683' } }, [])),
  ...literal,
].join('\n')

it('names only existing places, each in-app address matching its name', () => {
  const tabs = Object.fromEntries(PROJECT_TABS.map(k => [PROJECT_TAB_LABEL[k], k]))
  const named = [...texts.matchAll(/Settings › ([A-Z][a-z]+)(?: › ([A-Z][A-Z0-9]*) › ([A-Z][a-z]+))?(?: \(`#\/settings\?([^`]+)`\))?/g)]
  expect(named.length).toBeGreaterThanOrEqual(8)
  for (const [all, section, key, tab, query] of named) {
    expect(SETTINGS_SECTIONS, all).toContain(section!.toLowerCase())
    if (tab) expect(tabs[tab], all).toBeDefined()
    if (!query) continue
    const q = new URLSearchParams(query)
    expect(q.get('section'), all).toBe(section!.toLowerCase())
    expect(q.get('project') ?? undefined, all).toBe(key)
    expect(q.get('tab') ?? undefined, all).toBe(tab && tabs[tab])
  }
  // Guards, workflow and working branch: their own tab, with its address for an agent.
  expect(texts).toContain('Settings › Projects › CO › Guards (`#/settings?section=projects&project=CO&tab=guards`)')
  expect(texts).toContain('Settings › Projects › CO › Workflow (`#/settings?section=projects&project=CO&tab=workflow`)')
  expect(texts).toContain('Settings › Projects › CO › General (`#/settings?section=projects&project=CO&tab=general`)')
})
