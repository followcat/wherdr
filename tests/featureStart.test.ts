import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { startTask } from '../server/utils/pmLaunch'
import { clearFeatures } from '../server/utils/pmMechanic'
import { busyQueue, coordinatorStartRefusal } from '../shared/pm/autopilot'
import type { PmLaunchDeps } from '../server/utils/pmLaunch'

let dir = ''
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

async function setup() {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-feature-start-'))
  const store = createPmStore(dir)
  await store.setEnabled(true)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'WS', name: 'Work', machine: '', path: '/src/work', kind: 'workspace', git: false, addedAt: 1 }] }))
  const feature = await store.addTask({ project: 'WS', title: 'Ship it', type: 'feature' })
  return { store, feature, deps: { store, machines: () => [], call: async () => ({}) } as unknown as PmLaunchDeps }
}

it('a feature never starts: the start is refused and the feature stays as it was', async () => {
  const { store, feature, deps } = await setup()
  await expect(startTask(deps, feature.id, { by: 'user' })).rejects.toThrow('is a feature')
  expect(await store.task(feature.id)).toMatchObject({ state: 'todo' })
})

it('the engine and the autopilot never pick a feature', async () => {
  const { feature } = await setup()
  expect(busyQueue([feature])).toEqual([])
  expect(coordinatorStartRefusal(undefined, feature, [feature], [], Date.now(), false, { engine: true })).toMatch('is a feature')
})

it('a feature left waiting by a failed start is to do again', async () => {
  const { store, feature, deps } = await setup()
  await store.saveTask({ ...feature, state: 'waiting', waiting: 'The project folder is not a git repository' })
  await clearFeatures(deps)
  expect(await store.task(feature.id)).toMatchObject({ state: 'todo' })
  expect((await store.task(feature.id))!.waiting).toBeUndefined()
})
