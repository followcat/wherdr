// docs/migrate-from-1.x-docker.md is handed to an AI agent ("read this file and
// migrate me"): every step must say how to check it, its shell must parse, and
// everything that meets a 1.x Docker user must point to it.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(path.join(REPO, p), 'utf8')
const guide = read('docs/migrate-from-1.x-docker.md')
// Stable release notes keep the guide from the same release; live installers use main.
const RELEASE_GUIDE_URL = '/wherdr/blob/v2.0.0/docs/migrate-from-1.x-docker.md'

describe('the 1.x Docker migration guide', () => {
  it('ends every step and the way back with a check', () => {
    const steps = guide.split(/^## /m).slice(1)
    expect(steps.map(s => s.split('\n')[0])).toEqual([
      '0. Collect the facts', '1. Back up', '2. Keep the settings',
      '3. Stop the container and put the data in place', '4. Install the native service', '5. Verify', 'Roll back',
    ])
    for (const step of steps) expect(step, step.split('\n')[0]).toContain('**Check:**')
  })

  it('has shell blocks that parse', () => {
    const blocks = [...guide.matchAll(/```sh\n([\s\S]*?)```/g)].map(m => m[1]!)
    expect(blocks.length).toBeGreaterThanOrEqual(7)
    for (const block of blocks) execFileSync('sh', ['-n'], { input: block })
  })

  it('keeps the data, the image and the old folder for the way back', () => {
    expect(guide).toContain('docker compose down')
    expect(guide).not.toMatch(/docker compose down -v|docker (system|image) prune|rm -rf/)
    expect(guide).toContain('(cd "$OLD" && docker compose up -d)')
  })

  it('is linked from the release notes and the docs', () => {
    const notes = read('docs/release-notes-2.0.0.md')
    expect(notes).toContain(RELEASE_GUIDE_URL)
    expect(notes).not.toContain('/wherdr/blob/main/docs/migrate-from-1.x-docker.md')
    for (const doc of ['README.md']) expect(read(doc)).toContain('(docs/migrate-from-1.x-docker.md)')
    for (const doc of ['docs/README.md', 'docs/installation.md']) expect(read(doc)).toContain('](migrate-from-1.x-docker.md)')
  })
})
