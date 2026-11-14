// The "wherdr" agent skill (skills/wherdr/SKILL.md) must quote the exact
// messages of the Project panel and the list names it recognizes.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '..')
const skill = readFileSync(path.join(REPO, 'skills', 'wherdr', 'SKILL.md'), 'utf8')

describe('wherdr skill', () => {
  it('has the agent skill front matter', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? ''
    expect(fm).toMatch(/^name: wherdr$/m)
    expect(fm).toMatch(/^description: \S/m)
  })

  it('names the herdr-projects commands the Board runs', () => {
    for (const c of ['coordinator tell', 'tell <id>', 'approve <id>', 'list --json', 'details <id> --json']) expect(skill, c).toContain(c)
  })
})
