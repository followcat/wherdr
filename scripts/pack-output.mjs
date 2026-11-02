// Run by `npm pack` / `npm publish` (prepack), after `nuxt build`.
// Nitro links the packages it needs in several versions (tslib 1 and 2) from
// .output/server/node_modules/.nitro/<name>@<version>; npm drops symlinks from
// the tarball, so the server would miss them. Replace each link with a copy of
// its target, then remove the now unused .nitro folder.
import { cpSync, lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.output', 'server', 'node_modules')

function links(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) out.push(p)
    else if (entry.isDirectory()) links(p, out)
  }
  return out
}

let count = 0
for (const link of links(MODULES)) {
  const target = realpathSync(link)
  unlinkSync(link)
  cpSync(target, link, { recursive: true, dereference: true })
  count++
}
rmSync(path.join(MODULES, '.nitro'), { recursive: true, force: true })
if (links(MODULES).length || lstatSync(MODULES).isSymbolicLink()) throw new Error('symlinks left in .output/server/node_modules')
console.log(`pack-output: ${count} linked packages copied into .output/server/node_modules`)
