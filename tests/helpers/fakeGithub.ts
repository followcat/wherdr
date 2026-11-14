// A fake GitHub over a real bare origin, for the engine's simulation
// (tests/pmSimulation.test.ts): a `gh` shim on the PATH posts its arguments
// here and prints the answer. It knows the gh calls the engine's scripts make
// (shared/pm/actions.ts) and answers them as their jq filters would. PRs merge
// as real merge commits on origin; checks run for CHECK_MS after a head is
// first seen, then fail when its tree holds BROKEN; a conflict reads DIRTY.
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const CHECK_MS = 2 * 60_000
// Git as on a bare CI runner: no global config, a fixed identity.
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'sim', GIT_AUTHOR_EMAIL: 'sim@example.com', GIT_COMMITTER_NAME: 'sim', GIT_COMMITTER_EMAIL: 'sim@example.com',
}
interface Pr { n: number, url: string, head: string, base: string, merged?: string }
type Answer = { code: number, out: string } | null // null: never answers (a hung call)

// The shim: arguments joined by \037, the answer's first line its exit code.
export const GH_SHIM = `#!/bin/sh
o=$( { printf '%s\\037' "$PWD" "$@"; [ "$1 $2" != "pr create" ] || cat >/dev/null; } | curl -s --data-binary @- "$GH_FAKE") || { echo "gh: no answer" >&2; exit 1; }
c=$(printf '%s\\n' "$o" | head -1)
if [ "$c" = 0 ]; then printf '%s\\n' "$o" | tail -n +2; else printf '%s\\n' "$o" | tail -n +2 >&2; fi
exit "$c"`

export class FakeGithub {
  prs: Pr[] = []
  merged: string[] = [] // head branches, in merge order
  conflicts = new Set<string>() // head branches GitHub ever read DIRTY
  private seen = new Map<string, number>()
  private hung: http.ServerResponse[] = []
  private server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const [, ...argv] = body.split('\x1f')
      let a: Answer
      try { a = this.answer(argv.slice(0, -1)) } catch (e) { a = { code: 1, out: (e as Error).message } }
      if (a) res.end(`${a.code}\n${a.out}`)
      else this.hung.push(res)
    })
  })

  // failRead: an error for this branch's PR read now, else undefined. hang: this merge never answers.
  constructor(private origin: string, private hooks: { failRead?: (branch: string) => string | undefined, hang?: (branch: string) => boolean } = {}) {}

  async listen() {
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  // Hung calls fail now (their gh exits 1).
  cut() { for (const r of this.hung.splice(0)) r.destroy() }

  async close() {
    this.cut()
    this.server.closeAllConnections()
    await new Promise(r => this.server.close(r))
  }

  git(...args: string[]) {
    return execFileSync('git', ['-C', this.origin, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  }

  private tip = (branch: string) => { try { return this.git('rev-parse', '-q', '--verify', `refs/heads/${branch}`) } catch { return '' } }
  private headOf = (pr: Pr) => pr.merged ?? this.tip(pr.head)

  private checks(oid: string) {
    const at = this.seen.get(oid) ?? Date.now()
    this.seen.set(oid, at)
    if (Date.now() - at < CHECK_MS) return [{ name: 'ci', status: 'IN_PROGRESS' }]
    let red = true
    try { this.git('grep', '-q', 'BROKEN', oid, '--') } catch { red = false }
    return [{ name: 'ci', status: 'COMPLETED', conclusion: red ? 'FAILURE' : 'SUCCESS' }]
  }

  // The merge's tree, or undefined on a conflict.
  private mergeTree(pr: Pr) {
    try { return this.git('merge-tree', '--write-tree', `refs/heads/${pr.base}`, this.headOf(pr)).split('\n')[0] } catch { return undefined }
  }

  private full(pr: Pr) {
    const head = this.headOf(pr), range = `refs/heads/${pr.base}...${head}`
    const files = pr.merged ? [] : this.git('diff', '--numstat', range).split('\n').filter(Boolean).map((l) => {
      const [add, del, path] = l.split('\t')
      return { path: path!, additions: Number(add), deletions: Number(del) }
    })
    const dirty = !pr.merged && !this.mergeTree(pr)
    if (dirty) this.conflicts.add(pr.head)
    return {
      url: pr.url, baseRefName: pr.base, headRefOid: head, mergeStateStatus: dirty ? 'DIRTY' : 'CLEAN',
      statusCheckRollup: dirty ? [] : this.checks(head), files,
      additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
      commits: this.git('rev-list', `refs/heads/${pr.base}..${head}`).split('\n').filter(Boolean).map(oid => ({ oid })),
    }
  }

  private merge(url: string, match: string): Answer {
    const pr = this.prs.find(p => p.url === url && !p.merged)
    if (!pr) return { code: 1, out: 'no open PR' }
    if (this.hooks.hang?.(pr.head)) return null
    const head = this.tip(pr.head), tree = this.mergeTree(pr), base = this.tip(pr.base)
    if (head !== match) return { code: 1, out: 'Head branch was modified' }
    if (!tree) return { code: 1, out: 'Pull request is not mergeable: merge conflict' }
    const commit = this.git('commit-tree', tree, '-p', base, '-p', head, '-m', `Merge pull request #${pr.n}`)
    this.git('update-ref', `refs/heads/${pr.base}`, commit, base)
    pr.merged = head
    this.merged.push(pr.head)
    return { code: 0, out: '' }
  }

  private answer(argv: string[]): Answer {
    const flag = (f: string) => { const i = argv.indexOf(f); return i < 0 ? undefined : argv[i + 1] }
    const ok = (out: string | string[]) => ({ code: 0, out: Array.isArray(out) ? out.join('\n') : out })
    const [cmd, sub] = argv
    if (cmd === 'pr' && sub === 'list') {
      const head = flag('--head'), state = flag('--state'), json = flag('--json') ?? ''
      if (head && json.includes('statusCheckRollup')) {
        const why = this.hooks.failRead?.(head)
        if (why) return { code: 1, out: why }
      }
      const prs = this.prs.filter(p => (!head || p.head === head) && (!flag('--base') || p.base === flag('--base'))
        && (state === 'merged' ? p.merged : state === 'open' ? !p.merged : false))
      if (json.includes('statusCheckRollup')) return ok(JSON.stringify(prs.map(p => this.full(p))))
      if (json === 'url,baseRefName') return ok(prs.map(p => `${p.base} ${p.url}`))
      if (json === 'headRefOid,url') return ok(prs.map(p => `${p.merged} ${p.url}`))
      if (json === 'url,baseRefName,headRefOid') return ok(prs.map(p => `${p.merged} ${JSON.stringify({ url: p.url, baseRefName: p.base, headRefOid: p.merged, merged: true })}`))
      if (json === 'headRefOid') return ok(prs.map(p => p.merged!))
      return ok(json === 'url' ? prs[0]?.url ?? '' : '')
    }
    if (cmd === 'pr' && sub === 'create') {
      const n = this.prs.length + 1, url = `https://github.com/example/sim/pull/${n}`
      this.prs.push({ n, url, head: flag('--head')!, base: flag('--base')! })
      return ok(url)
    }
    if (cmd === 'pr' && sub === 'edit') { this.prs.find(p => p.url === argv[2])!.base = flag('--base')!; return ok('') }
    if (cmd === 'pr' && sub === 'merge') return this.merge(argv[2]!, flag('--match-head-commit')!)
    if (cmd === 'repo' && sub === 'view') return ok(flag('--json') === 'defaultBranchRef' ? 'main' : 'merge')
    if (cmd === 'api') return ok('false')
    if (cmd === 'run') return ok('')
    return { code: 1, out: `fake gh: unknown call ${argv.join(' ')}` }
  }
}
