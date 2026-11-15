// A Node before 22.13 has no usable node:sqlite: the agy pane must stay in
// Terminal mode with `unsupported`, never a crash — chat, model, search and
// the summaries fallback all degrade. `sqlite: null` injects the missing
// builtin; the fixture still writes a real database so every read path is
// actually attempted.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAgyTranscripts } from '../server/utils/agyTranscripts'
import { AGY_SESSION, writeAgyFixture } from './helpers/agy-fixture.mjs'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

it('a Node without node:sqlite answers unsupported everywhere, never a crash', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-agy-'))
  homes.push(home)
  writeAgyFixture(home, { rows: [{ role: 'user', text: 'Hi' }] })
  const pane = { id: 'p1', agent: 'agy', cwd: '/work/acme-shop', agentSession: AGY_SESSION }
  const agy = createAgyTranscripts({ home, sqlite: null })
  expect(await agy.chat(pane)).toMatchObject({ available: false, reason: 'unsupported' })
  expect(await agy.model(pane)).toBeNull()
  expect((await agy.search(pane, 'Hi', Date.now() + 5000)).hits).toEqual([])
  expect(await agy.summariesSession({ cwd: '/work/acme-shop' }, false)).toBeNull()
})
