// The world of the engine's simulation (tests/pmSimulation.test.ts): a temp
// home with a bare origin and the project's clone, herdr-core faked (scripts
// run for real in sh, on the fake GitHub's gh shim), and fake agents that work
// by committing a scripted change, then label themselves done.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FakeGithub, GH_SHIM, GIT_ENV } from './fakeGithub'
import { LABEL } from '../../shared/pm/run'
import { runFiles } from '../../shared/pm/advance'
import type { PmStore } from '../../server/utils/pmStore'

// What a fake worker does at its first start: lines appended to files.
export type Work = Record<string, string>
interface Term { address: string, labels: Record<string, string>, cwd: string, inbox: string[], finished?: boolean }

export async function makeWorld(hooks: ConstructorParameters<typeof FakeGithub>[1]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-sim-'))
  const origin = path.join(home, 'origin.git'), repo = path.join(home, 'project'), bin = path.join(home, '.local/bin')
  const env: NodeJS.ProcessEnv = { ...GIT_ENV, HOME: home, NVM_DIR: path.join(home, 'nvm') }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  await fs.mkdir(bin, { recursive: true })
  await fs.mkdir(path.join(repo, 'docs'), { recursive: true })
  for (const [f, text] of Object.entries({ 'README.md': '# sim\n', 'docs/llms.txt': '# Index\n', 'src/shared.txt': 'shared\n' })) {
    await fs.mkdir(path.dirname(path.join(repo, f)), { recursive: true })
    await fs.writeFile(path.join(repo, f), text)
  }
  git(home, 'init', '-q', '--bare', '-b', 'main', origin)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'start')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  const gh = new FakeGithub(origin, hooks)
  env.GH_FAKE = await gh.listen()
  await fs.writeFile(path.join(bin, 'gh'), GH_SHIM, { mode: 0o755 })
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  const terms: Term[] = [], worked = new Set<string>()
  const status = (t: Term) => ({ state: t.inbox.length ? 'working' : 'idle' })
  const sh = (argv: string[], input?: string) => new Promise<{ code: number | null, stdout: string }>((resolve) => {
    const p = spawn(argv[0]!, argv.slice(1), { env, stdio: ['pipe', 'pipe', 'ignore'] })
    const out: Buffer[] = []
    p.stdout.on('data', (b: Buffer) => out.push(b))
    p.on('close', code => resolve({ code, stdout: Buffer.concat(out).toString('base64') }))
    p.stdin.end(input ? Buffer.from(input, 'base64') : undefined)
  })
  const call = async (method: string, p: Record<string, unknown>): Promise<unknown> => {
    const term = terms.find(t => t.address === p.terminal)
    switch (method) {
      case 'machine.exec': return sh(p.argv as string[], p.input as string | undefined)
      case 'terminal.run': {
        const t: Term = { address: `t${terms.length + 1}`, labels: { ...(p.labels as Record<string, string>) }, cwd: String(p.cwd), inbox: ['start'] }
        terms.push(t)
        return { address: t.address }
      }
      case 'terminal.list': return { terminals: terms.map(t => ({ address: t.address, labels: t.labels, state: t.finished ? 'finished' : 'running', exit_code: t.finished ? 0 : undefined, status: status(t) })) }
      case 'terminal.get': return term ? { state: term.finished ? 'finished' : 'running', exit_code: term.finished ? 0 : undefined, status: status(term) } : null
      case 'terminal.send': term?.inbox.push(String(p.text)); return {}
      case 'terminal.label': for (const [k, v] of Object.entries(p.labels as Record<string, string>)) { if (v) term!.labels[k] = v; else delete term!.labels[k] } return {}
      case 'terminal.kill': if (term) term.finished = true; return {}
      default: return {}
    }
  }

  // Each live agent with something to do does it: its scripted work at its
  // first start, a conflict resolved, red CI fixed; then it says it is done,
  // unless it was told to stop and leave the push to the engine.
  async function runAgents(store: PmStore, work: Record<string, Work>) {
    for (const t of terms.filter(x => !x.finished && x.inbox.length)) {
      const run = (await store.runs()).find(r => r.id === t.labels[LABEL.run])!
      const files = runFiles(run.instructions)
      for (const item of t.inbox.splice(0)) {
        const text = item === 'start' ? await fs.readFile(run.instructions, 'utf8') : item
        const conflict = /Merge origin\/(\S+) into your branch/.exec(text)
        if (conflict) {
          git(t.cwd, 'fetch', '-q', 'origin', conflict[1]!)
          try { git(t.cwd, 'merge', '-q', '--no-edit', `origin/${conflict[1]}`) } catch {
            for (const f of git(t.cwd, 'diff', '--name-only', '--diff-filter=U').split('\n')) {
              const p = path.join(t.cwd, f)
              await fs.writeFile(p, (await fs.readFile(p, 'utf8')).split('\n').filter(l => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join('\n'))
              git(t.cwd, 'add', f)
            }
            git(t.cwd, 'commit', '-q', '--no-edit')
          }
        } else if (/CI failed/.test(text)) {
          for (const f of git(t.cwd, 'grep', '-l', 'BROKEN').split('\n')) {
            const p = path.join(t.cwd, f)
            await fs.writeFile(p, (await fs.readFile(p, 'utf8')).replaceAll('BROKEN', 'fixed'))
          }
          git(t.cwd, 'commit', '-qam', 'Fix CI')
        } else if (item === 'start' && !worked.has(run.task)) {
          for (const [f, line] of Object.entries(work[run.task] ?? {})) {
            await fs.mkdir(path.dirname(path.join(t.cwd, f)), { recursive: true })
            await fs.appendFile(path.join(t.cwd, f), `${line}\n`)
          }
          git(t.cwd, 'add', '-A')
          git(t.cwd, 'commit', '-qm', `${run.task}: work`)
          worked.add(run.task)
        } else continue
        if (!/then stop/.test(text)) {
          await fs.writeFile(files.note, `${run.task}: done.\n`)
          t.labels[LABEL.report] = 'done'
        }
      }
    }
  }

  const close = async () => {
    await gh.close()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { home, repo, origin, gh, call, runAgents, git, close }
}
