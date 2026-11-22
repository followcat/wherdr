import { expect, it } from 'vitest'
import { folderGuesses } from '../app/utils/pathFallback'

it('looks for a bare name in the folders quoted before it, nearest first', () => {
  const chips = ['~/pm/tasks/ABC-24/', 'docs/', 'report.md', 'src/a.ts', '~/later/']
  expect(folderGuesses(chips, 2)).toEqual(['docs/report.md', '~/pm/tasks/ABC-24/report.md'])
  expect(folderGuesses(chips, 3)).toEqual([]) // not a bare name
  expect(folderGuesses(['report.md', '~/later/'], 0)).toEqual([]) // no folder before it
})
