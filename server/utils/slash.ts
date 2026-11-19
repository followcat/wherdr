// omp's file commands (~/.omp/agent/commands, and those of Claude Code, Codex
// and ~/.agents that it also discovers), read on the pane's machine so the
// conversation can show "/name args" instead of the text omp sent.
import { machinePath } from './machinePath'
import type { MachineFs } from './fsx'

async function ls(fs: MachineFs, d: string) {
  try { return await fs.readdir(d) }
  catch { return [] }
}
async function read(fs: MachineFs, f: string) {
  try { return await fs.readFile(f) }
  catch { return null }
}

// omp's user config folders (~/.omp/agent for omp itself), from highest to
// lowest priority.
function ompConfigDirs(home: string) {
  return ['.omp/agent', '.agents', '.agent', '.claude', '.codex'].map(r => machinePath(home).join(home, r))
}

// Text of omp's file commands (without frontmatter), the user's ones:
// omp sends it instead of "/name args", the conversation puts the command back
// (see parseOmp).
export interface CommandTemplate { name: string, body: string }
export async function ompCommandTemplates(fs: MachineFs, home: string): Promise<CommandTemplate[]> {
  const out: CommandTemplate[] = []
  const path = machinePath(home)
  for (const d of ompConfigDirs(home)) {
    for (const n of await ls(fs, path.join(d, 'commands'))) {
      if (!n.endsWith('.md')) continue
      const text = await read(fs, path.join(d, 'commands', n))
      const body = text && text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
      if (body) out.push({ name: n.slice(0, -3), body })
    }
  }
  return out
}
