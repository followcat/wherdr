// wherdr 2 installed a "wherdr" agent skill for the Herdr Board
// (<wherdr dir>/skills/wherdr, linked from ~/.claude/skills and ~/.agents/skills).
// wherdr 3 ships no skill: the copy and its links are removed once, by the
// same helper (install-skill.sh uninstall, which only touches what it owns).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { wherdrDir } from './core.mjs'

export const SKILL_HELPER = fileURLToPath(new URL('./install-skill.sh', import.meta.url))

export function removeLegacySkill(env = process.env, run = spawnSync) {
  if (!existsSync(path.join(wherdrDir(env), 'skills', 'wherdr'))) return false
  try {
    run('sh', [SKILL_HELPER, 'uninstall'], { env, stdio: 'ignore', timeout: 5000 })
  } catch {} // Best effort: a read-only home or missing shell must not prevent startup.
  return true
}
