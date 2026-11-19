// A Windows host reads a remote Linux machine's conversations with POSIX
// paths (Node's default `path` is path.win32 there).
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:path', async () => {
  const real = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...real.win32, default: real.win32 }
})

const { default: path } = await import('node:path')
const { machinePath } = await import('../server/utils/machinePath')
const { createTranscripts } = await import('../server/utils/transcripts')
const { ompCommandTemplates } = await import('../server/utils/slash')
type MachineFs = import('../server/utils/fsx').MachineFs

// A machine's disk as a map of files; every path asked for is kept.
function memFs(files: Record<string, string>) {
  const asked: string[] = []
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const isDir = (p: string) => Object.keys(files).some(f => f.startsWith(p + '/'))
  const stat = async (p: string) => {
    asked.push(p)
    if (p in files) return { size: Buffer.byteLength(files[p]!), mtimeMs: 1, isFile: true, isDir: false, ino: 1 }
    if (isDir(p)) return { size: 0, mtimeMs: 1, isFile: false, isDir: true, ino: 2 }
    throw missing()
  }
  const fs: MachineFs = {
    stat,
    statMany: ps => Promise.all(ps.map(p => stat(p).catch(() => null))),
    async readdir(p) {
      asked.push(p)
      if (!isDir(p)) throw missing()
      return [...new Set(Object.keys(files).filter(f => f.startsWith(p + '/')).map(f => f.slice(p.length + 1).split('/')[0]!))]
    },
    async readFile(p) { asked.push(p); if (!(p in files)) throw missing(); return files[p]! },
    async read(p, start, len) { asked.push(p); if (!(p in files)) throw missing(); return Buffer.from(files[p]!).subarray(start, start + len) },
  }
  return { fs, asked }
}

describe('machinePath', () => {
  it('takes POSIX paths for a POSIX home, the platform default otherwise', () => {
    expect(path).toBe(path.win32)
    expect(machinePath('/home/user')).toBe(path.posix)
    expect(machinePath('C:\\Users\\user')).toBe(path.win32)
  })
})

describe('remote Linux machine read from a Windows host', () => {
  const home = '/home/user'
  const herdr = async () => ({ process_info: { foreground_processes: [] } })
  let disk: ReturnType<typeof memFs>
  beforeEach(() => {
    disk = memFs({
      [`${home}/.claude/projects/-home-user-project/claude-1.jsonl`]: '{}\n',
      [`${home}/.codex/sessions/2026/11/17/rollout-2026-11-17T10-00-00-codex-1.jsonl`]: '{}\n',
      [`${home}/.omp/agent/sessions/-home-user-project/omp-1.jsonl`]: '{}\n',
      [`${home}/.omp/agent/commands/hello.md`]: 'Say hello',
    })
  })
  const locate = (agent: string, agentSession: string) =>
    createTranscripts({ home, herdr, fs: disk.fs }).locate({ id: 'w1:p1', agent, cwd: `${home}/project`, agentSession })

  it('finds Claude, Codex and omp conversations, Devin with POSIX paths', async () => {
    expect((await locate('claude', 'claude-1'))?.file).toBe(`${home}/.claude/projects/-home-user-project/claude-1.jsonl`)
    expect((await locate('codex', 'codex-1'))?.file).toBe(`${home}/.codex/sessions/2026/11/17/rollout-2026-11-17T10-00-00-codex-1.jsonl`)
    const omp = `${home}/.omp/agent/sessions/-home-user-project/omp-1.jsonl`
    expect((await locate('omp', omp))?.file).toBe(omp)
    expect((await locate('devin', 'devin-1'))?.file).toBe(`${home}/.local/share/devin/cli/transcripts/devin-1.json`)
    expect(await ompCommandTemplates(disk.fs, home)).toEqual([{ name: 'hello', body: 'Say hello' }])
    expect(disk.asked.filter(p => p.includes('\\'))).toEqual([])
  })

  it('keeps win32 paths for a Windows home', async () => {
    const win = 'C:\\Users\\user'
    const { fs, asked } = memFs({})
    await createTranscripts({ home: win, herdr, fs }).locate({ id: 'w1:p1', agent: 'claude', cwd: win, agentSession: 'claude-1' })
    expect(asked).toContain('C:\\Users\\user\\.claude\\projects')
  })
})
