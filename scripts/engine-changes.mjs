#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Keep engine inputs here, alongside the filter regression tests. Release assembly
// is added by later distribution work; these paths already require engine checks.
export function needsEngine(paths) {
  return paths.some(p => /^(engine|packages|skills\/wherdr-board|tests\/recordings\/wherdr-board)\//.test(p)
    || /^(package(?:-lock)?\.json|herdr-plugin\.toml)$/.test(p)
    || /^(bin|scripts)\/.*(?:board|runtime|userpath|pack|updat|version|release|engine)/.test(p)
    || /^shared\/projectsPlugin\.ts$|^server\/utils\/(?:projects(?:Tasks|Plugin)|boardLinks)\.ts$/.test(p)
    || /^tests\/.*(?:[Bb]oard|[Pp]rojects|[Pp]lugin|[Mm]igration|[Cc]ohabitation|[Dd]istribution|engine)/.test(p)
    || /^\.github\/workflows\/(?:ci|engine-.*|release.*|develop-prerelease|npm)\.yml$/.test(p))
}

export function engineDecision(event, before, cwd = process.cwd()) {
  if (!['pull_request', 'push'].includes(event)) return true
  const base = event === 'pull_request' ? 'HEAD^1' : before
  if (!base || /^0+$/.test(base)) return true
  // No rename detection: a move is a deletion plus addition, including both
  // sides of moves across engine/. NUL separation preserves unusual filenames.
  const diff = spawnSync('git', ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--'], { cwd, encoding: 'utf8' })
  if (diff.status !== 0) return true
  return needsEngine(diff.stdout.split('\0').filter(Boolean))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const needed = engineDecision(process.env.EVENT, process.env.BEFORE)
  console.log(`Engine checks needed: ${needed}`)
  appendFileSync(process.env.GITHUB_OUTPUT, `engine=${needed}\n`)
}
