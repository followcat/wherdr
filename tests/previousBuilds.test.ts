import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { keepBuild, previousBuildFile } from '../server/utils/previousBuilds'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })

// A fresh folder per test: a built public folder for each build, one store.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-builds-'))
  roots.push(root)
  const build = (id: string, files: string[]) => {
    const pub = path.join(root, 'pub-' + id)
    fs.mkdirSync(path.join(pub, '_nuxt', 'builds'), { recursive: true })
    fs.writeFileSync(path.join(pub, '_nuxt', 'builds', 'latest.json'), JSON.stringify({ id }))
    for (const f of files) {
      fs.writeFileSync(path.join(pub, '_nuxt', f), `${id}:${f}`)
      fs.writeFileSync(path.join(pub, '_nuxt', f + '.br'), 'compressed')
    }
    return pub
  }
  return { build, store: path.join(root, 'store') }
}

it('serves an older build\'s chunk after an update, and drops builds past the retention', () => {
  const { build, store } = setup()
  keepBuild(build('a', ['old.js', 'shared.js']), store, 'a', 1)
  keepBuild(build('b', ['b.js', 'shared.js']), store, 'b', 2)
  keepBuild(build('c', ['c.js']), store, 'c', 3)
  const dirs = keepBuild(build('d', ['d.js']), store, 'd', 4)

  expect(dirs.map(d => path.basename(d))).toEqual(['c', 'b'])
  expect(fs.readFileSync(previousBuildFile(dirs, 'shared.js')!, 'utf8')).toBe('b:shared.js')
  expect(previousBuildFile(dirs, 'old.js')).toBeNull()
  expect(previousBuildFile(dirs, 'c.js.br')).toBeNull()
  expect(previousBuildFile(dirs, '../d/d.js')).toBeNull()
  expect(fs.readdirSync(store).sort()).toEqual(['b', 'c', 'd'])
})
