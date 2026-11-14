// The engine's real scripts under each POSIX shell found here, through the real
// actionShell: gh's JSON keeps its escapes, and stderr warnings (ssh, gh) are
// never read as a result. No network: a bare origin reached through a fake ssh.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SCRIPT, readPrInfo, taskGuards } from '../shared/pm/actions'
import { actionShell, dropMergedBranch, watch } from '../server/utils/pmActions'

const SHELLS = [['dash'], ['bash', '--posix'], ['sh']].filter(([s]) => spawnSync('sh', ['-c', `command -v ${s}`]).status === 0)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-scripts-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const SHA = /^[0-9a-f]{40}$/
const PRS = [{ url: 'https://github.com/o/r/pull/1', baseRefName: 'dev', headRefOid: '', mergeStateStatus: 'CLEAN', statusCheckRollup: [], title: 'a\nb\tc\\d\\cut', commits: [] as { oid: string }[] }]

// HOME's .local/bin comes first in PATH_SETUP: the gh stub wins over any real one.
const home = path.join(tmp, 'home'), bin = path.join(home, '.local/bin')
fs.mkdirSync(bin, { recursive: true })
const exe = (f: string, body: string) => fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
exe(path.join(bin, 'gh'), `echo 'warning: x' >&2; h=$(git rev-parse HEAD)
case "$*" in
  *mergeStateStatus*) cat "${tmp}/prs.json";;
  "pr create"*) echo https://github.com/o/r/pull/1;;
  *"--state merged --json headRefOid -q"*) echo "$h";;
  "run list"*) printf '[{"databaseId":1,"status":"completed","conclusion":"success","headSha":"%s","url":"https://run/1"}]\\n' "$h";;
  "api"*) echo false;; "repo view"*) echo main;;
esac`)
// ssh, simple variant (host, command): a warning, then the command run here.
const ssh = path.join(tmp, 'ssh'); exe(ssh, `echo 'warning: post-quantum key exchange' >&2; exec sh -c "$2"`)
const env = { PATH: process.env.PATH!, HOME: home, GIT_SSH: ssh, GIT_SSH_VARIANT: 'simple', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()

const origin = path.join(tmp, 'origin.git'), wt = path.join(tmp, 'wt')
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
git(tmp, 'init', '-q', '-b', 'main', wt)
git(wt, 'remote', 'add', 'origin', `ssh://example.invalid${origin}`)
git(wt, 'commit', '-q', '--allow-empty', '-m', 'base'); git(wt, 'push', '-q', 'origin', 'main', 'main:dev')
git(wt, 'checkout', '-q', '-b', 'task/x'); git(wt, 'commit', '-q', '--allow-empty', '-m', 'a\\nb \\c -n')
const head = git(wt, 'rev-parse', 'HEAD')
PRS[0]!.headRefOid = head; PRS[0]!.commits = [{ oid: head }]
fs.writeFileSync(path.join(tmp, 'prs.json'), `${JSON.stringify(PRS)}\n`)

describe.each(SHELLS)('the engine scripts under %s', (...shell) => {
  // herdr-core's machine.exec, run here with this shell in place of sh.
  const sh = actionShell({ call: (async (_m: string, p: { argv: string[], input?: string }) => {
    const r = spawnSync(shell[0]!, [...shell.slice(1), ...p.argv.slice(1)], { env, encoding: 'utf8', input: p.input && Buffer.from(p.input, 'base64').toString() })
    const b64 = (s: string) => Buffer.from(s).toString('base64')
    return { code: r.status, stdout: b64(r.stdout), stderr: b64(r.stderr) }
  }) as never }, undefined)

  it('reads stdout only, with gh\'s JSON as it was', async () => {
    const info = readPrInfo((await sh(SCRIPT.prInfo, [wt, 'task/x'])).out)
    expect(info).toEqual({ head, prs: PRS })
    expect(info!.prs[0]!.commits!.every(c => SHA.test((c as { oid: string }).oid))).toBe(true)
    expect((await sh(SCRIPT.pr, [wt, 'task/x', 'dev', 'A-1: x'], 'body')).out).toBe('https://github.com/o/r/pull/1')
    expect((await sh(SCRIPT.remoteHead, [wt, 'task/x'])).out).toBe(head)
    expect((await sh(SCRIPT.remoteHead, [wt, 'none'])).out).toBe('')
    expect(await watch({ sh }, { worktree: wt, action: { kind: 'pipeline.watch', branch: 'task/x' } })).toEqual({ ok: true, link: 'https://run/1' })
    expect((await sh(SCRIPT.land, [wt, 'dev'])).out).toBe(head)
    expect(git(wt, 'ls-remote', 'origin', 'refs/heads/dev').split('\t')[0]).toBe(head)
    const g = taskGuards({ id: 'p', guards: { protected: ['main'] }, taskTypes: {} } as never, 'simple')
    expect(await dropMergedBranch(sh, { worktree: wt, branch: 'task/x', guards: g, bases: ['dev'], on: true })).toBe('deleted the remote branch task/x')
    git(wt, 'push', '-q', 'origin', 'task/x')
  })
})
