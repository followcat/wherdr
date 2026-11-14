import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const root = fileURLToPath(new URL('../', import.meta.url))
const repo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  .repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
const rawRepo = `${repo.replace('github.com', 'raw.githubusercontent.com')}/main/`

// GitHub heading IDs preserve each space as a dash, including consecutive ones.
function anchors(tokens, source) {
  const ids = new Set([...source.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]))
  marked.walkTokens(tokens, token => {
    if (token.type !== 'heading') return
    const base = token.text.replace(/<[^>]*>/g, '').replace(/[*_`]/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, '').trim().replace(/\s/g, '-')
    let id = base
    for (let n = 1; ids.has(id); n++) id = `${base}-${n}`
    ids.add(id)
  })
  return ids
}

/** The heading anchors (and explicit ids) of a Markdown file, as GitHub makes them. */
export function docAnchors(path) {
  const source = readFileSync(path, 'utf8')
  return anchors(marked.lexer(source), source)
}

/** Check Markdown/HTML links and repository documentation URLs without network requests. */
export function checkDocLinks() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
  const cache = new Map()
  const errors = []
  function document(path) {
    if (!cache.has(path)) {
      const source = readFileSync(path, 'utf8')
      const tokens = marked.lexer(source)
      cache.set(path, { source, tokens, ids: anchors(tokens, source) })
    }
    return cache.get(path)
  }
  function check(file, href) {
    let target = href.replace(/&amp;/g, '&')
    if (target.startsWith(`${repo}/blob/main/`)) target = target.slice(`${repo}/blob/main/`.length)
    else if (target.startsWith(`${repo}#`)) target = `README.md${target.slice(repo.length)}`
    else if (target.startsWith(rawRepo)) target = target.slice(rawRepo.length)
    else if (/^[a-z][\w+.-]*:|^\/\//i.test(target)) return
    else if (target.startsWith('/')) return // App/site routes are not repository paths.
    else return checkLocal(file, target, dirname(resolve(root, file)))
    checkLocal(file, target, root)
  }
  function checkLocal(file, target, base) {
    const [path, hash] = target.split('#')
    const full = path ? resolve(base, decodeURIComponent(path.split('?')[0])) : resolve(root, file)
    if (!existsSync(full)) { errors.push(`${file}: missing file ${target}`); return }
    if (hash && extname(full) === '.md' && statSync(full).isFile() && !document(full).ids.has(decodeURIComponent(hash))) {
      errors.push(`${file}: missing anchor ${target}`)
    }
  }
  for (const file of [...new Set(files)]) {
    if (!/\.(md|txt|vue|ts|mjs|css)$/.test(file) && file !== 'website/public/install') continue
    const full = resolve(root, file)
    if (!existsSync(full)) continue
    const source = readFileSync(full, 'utf8')
    if (file.endsWith('.md')) {
      const { tokens } = document(full)
      marked.walkTokens(tokens, token => {
        if (token.type === 'link' || token.type === 'image') check(file, token.href)
        if (token.type === 'html') {
          for (const [, href] of token.text.matchAll(/(?:href|src)=["']([^"']+)["']/g)) check(file, href)
        }
      })
    }
    // Also cover plain URLs in agent guides and URLs composed from REPO in Vue/TS/shell.
    const expanded = source.replaceAll('${REPO}', repo).replaceAll('https://github.com/$REPO', repo)
    for (const [url] of expanded.matchAll(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/main\/docs\/[^\s"'`<>)}$]+/g)) {
      if (url.startsWith(`${repo}/`)) check(file, url.replace(/[.,;:]+$/, ''))
    }
    for (const [path] of expanded.matchAll(/(?<=["'])\/blob\/main\/docs\/[^\s"'`<>)}$]+/g)) check(file, `${repo}${path}`)
    for (const [url] of expanded.matchAll(/https:\/\/github\.com\/[^/\s]+\/[^/#\s]+#[\w-]+/g)) {
      if (url.startsWith(`${repo}#`)) check(file, url)
    }
  }
  return [...new Set(errors)]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkDocLinks()
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('Documentation links: files and anchors OK (including app, site and agent guides).')
}
