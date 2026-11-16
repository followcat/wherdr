// node:sqlite is only unflagged from Node 22.13 and warns when it loads: the
// reader must import it lazily, on the first conversation read only, so other
// agents never pay it. `process.moduleLoadList` records every builtin a
// process loads — importing the reader module and building it must not add
// the entry; the first chat read does. This file never imports the fixture
// helper, whose own static node:sqlite import would poison the check.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAgyTranscripts } from '../server/utils/agyTranscripts'

const AGY_SESSION = '11111111-2222-4333-8444-555555555555'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

it('loads node:sqlite only when an Antigravity conversation is read', async () => {
  const sqliteLoaded = () => process.moduleLoadList.some(l => l === 'NativeModule sqlite')
  expect(sqliteLoaded()).toBe(false)
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-agy-'))
  homes.push(home)
  const agy = createAgyTranscripts({ home })
  expect(sqliteLoaded()).toBe(false)
  // No database on disk: the read answers `not_found`, but sqliteReady had to
  // load the builtin first — the exact moment the laziness ends.
  const r = await agy.chat({ id: 'p1', agent: 'agy', cwd: '/work/acme-shop', agentSession: AGY_SESSION })
  expect(r.available).toBe(false)
  expect(sqliteLoaded()).toBe(true)
})
