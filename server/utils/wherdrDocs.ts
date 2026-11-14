// wherdr's docs on its own machine, for Alfred and the local coordinators:
// the first folder with llms.txt (the index) among
// 1. the build's own copy, .output/docs, under WHERDR_ROOT or the running
//    server (auto-deploy packages ship it: they replace .output only, so the
//    clone's docs/ may be older);
// 2. WHERDR_ROOT/docs (the package root the CLI sets);
// 3. the docs/ next to the running .output (started without the CLI, from
//    another folder: a service without a working directory);
// 4. the working folder's docs/ (npm start in a checkout).
// None has it: the last one tried, so the role text names a place.
import fs from 'node:fs'
import path from 'node:path'

export function findDocsDir(env: NodeJS.ProcessEnv = process.env, entry = process.argv[1], cwd = process.cwd()): string {
  const root = env.WHERDR_ROOT
  // The server's entry is .output/server/index.mjs.
  const up = entry ? path.resolve(path.dirname(entry), '..') : ''
  const output = path.basename(up) === '.output' ? up : ''
  const tries = [
    root && path.join(root, '.output', 'docs'),
    output && path.join(output, 'docs'),
    root && path.join(root, 'docs'),
    output && path.join(output, '..', 'docs'),
    path.join(cwd, 'docs'),
  ].filter((d): d is string => !!d)
  return tries.find(d => fs.existsSync(path.join(d, 'llms.txt'))) ?? tries.at(-1)!
}
