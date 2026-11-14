import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { archiveDone, board, cardById, unarchiveTask } from '../server/utils/pmBoard'
import { issueToken, runCommand } from '../server/utils/pmCoordinator'
import { updateProject } from '../server/utils/pmProject'
import { common } from '../shared/pm/examples'
import type { CoreAdminDeps } from '../server/utils/coreCreate'

const DAY = 86_400_000
let dir = '', store: ReturnType<typeof createPmStore>

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-archive-'))
  store = createPmStore(dir)
  await store.setEnabled(true)
  await store.saveTemplate(common)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [
    { key: 'CO', name: 'Company', machine: '', path: '/src/co', template: 'common', addedAt: 1 },
  ] }))
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

// A task done `daysAgo` days ago (its done mark), or still working.
async function task(title: string, daysAgo?: number) {
  const t = await store.addTask({ project: 'CO', title, type: 'study' })
  if (daysAgo === undefined) return t
  const at = Date.now() - daysAgo * DAY
  const done = { ...t, state: 'working' as const, step: { at: 0, started: true, done: true, proofs: {}, rounds: {} } }
  await store.saveTask(done)
  // The store marks the write now: the done mark goes back in time.
  const saved = (await store.task(t.id))!
  await fs.writeFile(path.join(store.files.tasks, `${t.id}.json`), JSON.stringify({ ...saved, marks: [{ at, step: 0, done: true }] }))
  return saved
}

describe('auto-archive', () => {
  it('archives a task done for longer than the delay, logs it, and takes it off the board', async () => {
    const old = await task('Old', 8), recent = await task('Recent', 2), open = await task('Open')
    await archiveDone(store)
    expect((await store.task(old.id))!.archived).toBeTypeOf('number')
    expect((await store.task(old.id))!.log!.at(-1)!.text).toBe('archived after 7 days done')
    expect((await store.task(recent.id))!.archived).toBeUndefined()
    expect((await store.task(open.id))!.archived).toBeUndefined()
    const b = await board(store)
    expect(b.cards.map(c => c.id)).toEqual([open.id, recent.id])
    expect(b.archived).toEqual({ CO: 1 })
    // A link to it still finds its card.
    expect((await cardById(store, [], old.id)).card).toMatchObject({ id: old.id, archived: expect.any(Number) })
  })

  it('lists done tasks newest done first', async () => {
    const older = await task('Older', 3), newer = await task('Newer', 1)
    expect((await board(store)).cards.map(c => c.id)).toEqual([newer.id, older.id])
  })

  it('Never keeps done tasks; a shorter delay archives at once', async () => {
    const t = await task('Done', 40)
    await updateProject(store, 'CO', { archiveAfter: 0 })
    await archiveDone(store)
    expect((await store.task(t.id))!.archived).toBeUndefined()
    await updateProject(store, 'CO', { archiveAfter: 30 })
    expect((await store.task(t.id))!.log!.at(-1)!.text).toBe('archived after 30 days done')
    await expect(updateProject(store, 'CO', { archiveAfter: 5 })).rejects.toThrow('archiveAfter')
  })

  it('unarchive brings it back to Done, and its delay runs again from then', async () => {
    const t = await task('Done', 8)
    await archiveDone(store)
    await unarchiveTask(store, t.id)
    await archiveDone(store)
    expect((await store.task(t.id))!.archived).toBeUndefined()
    expect((await board(store)).cards.find(c => c.id === t.id)?.phase).toBe('done')
    await expect(unarchiveTask(store, t.id)).rejects.toThrow('not archived')
  })
})

it('pm list leaves archived tasks out; --archived lists only them', async () => {
  const old = await task('Old', 8), open = await task('Open')
  await archiveDone(store)
  const token = await issueToken(store, 'CO')
  const list = async (argv: string[]) => ((await runCommand({ store, machines: () => [] } as unknown as CoreAdminDeps & { store: typeof store }, token, { argv })) as { tasks: { id: string }[] }).tasks.map(x => x.id)
  expect(await list(['list'])).toEqual([open.id])
  expect(await list(['list', '--archived'])).toEqual([old.id])
})
