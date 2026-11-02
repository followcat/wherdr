// "/" commands offered by the input field, like the terminal's menu:
// the agent's built-in commands (slashcatalog.ts) + those read on the
// pane's machine (local disk, or SSH):
//  - Claude Code: skills (~/.claude/skills/**/SKILL.md, including those
//    synced from the account), commands (~/.claude/commands/**.md), and
//    the same in the .claude/ of the pane's folder and of its parents (see
//    claudeProjectDirs), plus enabled plugins (namespaced skills/commands).
//  - Codex: personal prompts ~/.codex/prompts/*.md -> /prompts:<name>.
//  - omp: commands (~/.omp/agent/commands, and those of Claude Code, Codex and
//    ~/.agents that it also discovers), skills -> /skill:<name> (same folders,
//    plus `skills.customDirectories` of ~/.omp/agent/config.yml), and the same
//    in the project folder.
//
// On an SSH machine everything is read by one shell script (one session of
// the shared connection, see machines.ts): one exec per folder and file was
// slow and a single refused session dropped the whole list.
import path from 'node:path'
import type { SlashCommand } from '../../shared/types'
import { type MachineFs, type ShellExec, dirDeniedFromError } from './fsx'
import { CLAUDE_BUILTIN, CMD_BUILTIN, CODEX_BUILTIN, OMP_BUILTIN } from './slashcatalog'

// Short: a skill or command added on the machine shows up within seconds,
// as in the terminal (Claude Code watches its folders).
const TTL = 20 * 1000
// `denied`: macOS refused to list some of the folders (privacy protection,
// see LIST_DIRS_SCRIPT): their commands are missing from `commands`.
export interface SlashResult { commands: SlashCommand[], denied?: 'macos' }
const cache = new Map<string, { at: number, result: SlashResult }>()

// Minimal YAML frontmatter (simple one-line keys).
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

// First useful sentence of a command file without a description.
function firstLine(text: string) {
  const body = text.replace(/^---[\s\S]*?\n---\r?\n?/, '')
  const l = body.split('\n').map(s => s.replace(/^#+\s*/, '').trim()).find(Boolean)
  return l ? l.slice(0, 200) : ''
}

async function ls(fs: MachineFs, d: string) {
  try { return await fs.readdir(d) }
  catch { return [] }
}
// Like ls, but tells a folder macOS refuses to list from a missing one.
async function lsRoot(fs: MachineFs, d: string): Promise<string[] | 'denied'> {
  try { return await fs.readdir(d) }
  catch (err) { return dirDeniedFromError(err) === 'macos' ? 'denied' : [] }
}
async function read(fs: MachineFs, f: string) {
  try { return await fs.readFile(f) }
  catch { return null }
}

// Where commands come from: `skills` = <dir>/<name>/SKILL.md up to two more
// levels (skills/synced/<account>/<name>/); `commands` = <dir>/**.md, `depth`
// subfolder levels giving "folder:command" names; `file` = one file;
// `exists` = only whether the path exists (a `.git`). `includeRoot` also
// reads SKILL.md directly in a declared plugin skill directory.
export interface SlashRoot { dir: string, kind: 'skills' | 'commands' | 'file' | 'exists', prefix?: string, depth?: number, includeRoot?: boolean }
// A file found under a root: its path relative to it ('' for a `file`) and its start.
export interface SlashFile { root: number, rel: string, text: string }
// Files found, and the roots macOS refused to list.
export interface SlashFiles { files: SlashFile[], denied: number[] }

const HEAD = 16384
// Registries can list hundreds of plugins; do not truncate them like skill text.
const META_HEAD = 1024 * 1024

async function collectLocal(fs: MachineFs, roots: SlashRoot[]): Promise<SlashFiles> {
  const out: SlashFile[] = []
  const denied: number[] = []
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i]!
    if (r.kind === 'exists') {
      if (await fs.stat(r.dir).then(() => true, () => false)) out.push({ root: i, rel: '', text: '' })
      continue
    }
    if (r.kind === 'file') {
      const text = await read(fs, r.dir)
      if (text !== null) out.push({ root: i, rel: '', text })
      continue
    }
    const top = await lsRoot(fs, r.dir)
    if (top === 'denied') { denied.push(i); continue }
    if (r.kind === 'skills') {
      const dirs: string[] = r.includeRoot ? [''] : []
      for (const a of top) {
        dirs.push(a)
        for (const b of await ls(fs, path.join(r.dir, a))) {
          if (b === 'SKILL.md') continue
          dirs.push(path.join(a, b))
          for (const c of await ls(fs, path.join(r.dir, a, b))) if (c !== 'SKILL.md') dirs.push(path.join(a, b, c))
        }
      }
      const rels = dirs.map(d => path.join(d, 'SKILL.md'))
      const st = rels.length ? await fs.statMany(rels.map(f => path.join(r.dir, f))).catch(() => []) : []
      for (let j = 0; j < rels.length; j++) {
        if (!st[j] || !st[j]!.isFile) continue
        const text = await read(fs, path.join(r.dir, rels[j]!))
        if (text !== null) out.push({ root: i, rel: rels[j]!, text })
      }
    } else {
      const walk = async (rel: string, depth: number) => {
        for (const n of rel ? await ls(fs, path.join(r.dir, rel)) : top) {
          const f = rel ? path.join(rel, n) : n
          if (n.endsWith('.md')) {
            const text = await read(fs, path.join(r.dir, f))
            if (text !== null) out.push({ root: i, rel: f, text })
          } else if (depth < (r.depth ?? 2) && !n.includes('.')) await walk(f, depth + 1)
        }
      }
      await walk('', 0)
    }
  }
  return { files: out, denied }
}

// Arguments: pairs <kind> <dir>. One record per file found:
// RS <root index> US <relative path> US <first bytes>; RS D US <root index> US
// for a folder macOS refuses to list (`find` alone would print nothing, as
// for a missing folder: `ls` tells them apart, see LIST_DIRS_SCRIPT).
export const SLASH_SCRIPT = `i=0
os=$(uname -s)
while [ $# -ge 2 ]; do
  k=$1; d=$2; shift 2
  case $k in
    exists) if [ -e "$d" ]; then printf '\\036%s\\037\\037' "$i"; fi ;;
    file) if [ -f "$d" ]; then printf '\\036%s\\037\\037' "$i"; head -c ${META_HEAD} "$d"; fi ;;
    skills|skills-root|commands*)
      if [ "$k" = skills ] || [ "$k" = skills-root ]; then lo=2; [ "$k" = skills-root ] && lo=1; hi=4; name=SKILL.md; else lo=1; hi=$((\${k#commands} + 1)); name='*.md'; fi
      case $(LC_ALL=C ls -A "$d" 2>&1 >/dev/null) in
        *"not permitted"*) [ "$os" = Darwin ] && printf '\\036D\\037%s\\037' "$i" ;;
      esac
      if [ -d "$d" ]; then
        find -L "$d" -mindepth $lo -maxdepth $hi -name "$name" -type f 2>/dev/null | sort | while IFS= read -r f; do
          printf '\\036%s\\037%s\\037' "$i" "\${f#"$d"/}"; head -c ${HEAD} "$f"
        done
      fi ;;
  esac
  i=$((i + 1))
done
exit 0`

export function parseSlashFiles(out: string): SlashFiles {
  const files: SlashFile[] = []
  const denied: number[] = []
  for (const rec of out.split('\x1E')) {
    const a = rec.indexOf('\x1F')
    const b = a < 0 ? -1 : rec.indexOf('\x1F', a + 1)
    if (b < 0) continue
    if (rec.slice(0, a) === 'D') denied.push(Number(rec.slice(a + 1, b)))
    else files.push({ root: Number(rec.slice(0, a)), rel: rec.slice(a + 1, b), text: rec.slice(b + 1) })
  }
  return { files, denied }
}

// One script run; a failed run (a session the connection refused…) is
// retried once, then thrown: never mistaken for "no commands".
async function collectRemote(exec: ShellExec, roots: SlashRoot[]): Promise<SlashFiles> {
  const args = roots.flatMap(r => [r.kind === 'commands' ? `commands${r.depth ?? 2}` : r.kind === 'skills' && r.includeRoot ? 'skills-root' : r.kind, path.posix.normalize(r.dir).replace(/(.)\/+$/, '$1')])
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 400)
      await promise
    }
    const r = await exec(SLASH_SCRIPT, args, { timeoutMs: 20000 })
    if (r.code === 0) return parseSlashFiles(r.stdout.toString('utf8'))
    last = (r.stderr || `code ${r.code}`).trim().split('\n').pop() || 'failed'
  }
  throw new Error(last)
}

// Commands of the files found, in root then path order.
export function commandsOf(roots: SlashRoot[], files: SlashFile[]): SlashCommand[] {
  const out: SlashCommand[] = []
  const sorted = [...files].sort((a, b) => a.root - b.root || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const f of sorted) {
    const r = roots[f.root]
    if (!r || r.kind === 'file' || r.kind === 'exists') continue
    const parts = f.rel.split('/')
    const fm = frontmatter(f.text)
    const hint = fm['argument-hint'] || undefined
    if (r.kind === 'skills') {
      if (parts.length < (r.includeRoot ? 1 : 2) || parts.length > 4 || parts.at(-1) !== 'SKILL.md' || fm['user-invocable'] === 'false') continue
      out.push({ name: (r.prefix || '') + (fm.name || parts.at(-2) || path.basename(r.dir)), desc: fm.description || '', hint, source: 'skill' })
    } else {
      const dirs = parts.slice(0, -1)
      if (!parts.at(-1)!.endsWith('.md') || dirs.length > (r.depth ?? 2) || dirs.some(d => d.includes('.'))) continue
      out.push({ name: (r.prefix || '') + [...dirs, parts.at(-1)!.slice(0, -3)].join(':'), desc: fm.description || firstLine(f.text), hint, source: 'command' })
    }
  }
  return out
}

// `skills.customDirectories` of omp's config (YAML: list under the key).
export function ompSkillDirs(config: string, home: string): string[] {
  const out: string[] = []
  let inSkills = false
  let inList = false
  for (const line of config.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      inSkills = /^skills:\s*$/.test(line)
      inList = false
    } else if (inSkills && /^\s+customDirectories:\s*$/.test(line)) {
      inList = true
    } else if (inList) {
      const item = /^\s+-\s+(.+?)\s*$/.exec(line)
      if (!item) { inList = false; continue }
      const dir = item[1]!.replace(/^(["'])(.*)\1$/, '$2')
      out.push(dir === '~' || dir.startsWith('~/') ? path.join(home, dir.slice(1)) : path.resolve(home, dir))
    }
  }
  return out
}

export function mergeCommands(builtin: [string, string, string?][], extra: SlashCommand[]): SlashCommand[] {
  const out: SlashCommand[] = []
  const seen = new Set<string>()
  // Personal commands first: they hide a built-in one with the same name.
  for (const c of extra) {
    if (!c.name || seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }
  for (const [name, desc, hint] of builtin) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, desc, hint, source: 'builtin' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function builtinCommands(kind: string) {
  return mergeCommands(kind === 'claude' ? CLAUDE_BUILTIN : kind === 'codex' ? CODEX_BUILTIN : kind === 'omp' ? OMP_BUILTIN : kind === 'cmd' ? CMD_BUILTIN : [], [])
}

// Project folders whose .claude/ Claude Code reads (getProjectDirsUpToHome,
// checked in 2.1.301): the pane's folder then its parents, stopping at the
// Git root (the folder holding `.git`, see claudeCommands) and never reaching
// the home folder, whose .claude/ is the user's. Nearest first.
export function claudeProjectDirs(cwd: string | null, home: string): string[] {
  if (!cwd) return []
  const stop = path.resolve(home)
  const out: string[] = []
  for (let d = path.resolve(cwd); d !== stop; d = path.dirname(d)) {
    out.push(d)
    if (path.dirname(d) === d) break
  }
  return out
}

async function claudeCommands(collect: (roots: SlashRoot[]) => Promise<SlashFiles>, home: string, cwd: string | null) {
  // Per project folder: its .git, then its skills and commands; the user's last.
  const dirs = claudeProjectDirs(cwd, home)
  const roots: SlashRoot[] = dirs.flatMap(d => [
    { dir: path.join(d, '.git'), kind: 'exists' as const },
    { dir: path.join(d, '.claude/skills'), kind: 'skills' as const },
    { dir: path.join(d, '.claude/commands'), kind: 'commands' as const },
  ])
  roots.push({ dir: path.join(home, '.claude/skills'), kind: 'skills' }, { dir: path.join(home, '.claude/commands'), kind: 'commands' })
  const settings = [home, ...dirs.toReversed()].flatMap(d => [
    { dir: path.join(d, '.claude/settings.json'), kind: 'file' as const },
    ...(d === home ? [] : [{ dir: path.join(d, '.claude/settings.local.json'), kind: 'file' as const }]),
  ])
  const settingsStart = roots.length
  roots.push(...settings, { dir: path.join(home, '.claude/plugins/installed_plugins.json'), kind: 'file' })
  const { files, denied } = await collect(roots)
  // Folders above the Git root: Claude Code does not read them.
  const git = files.filter(f => roots[f.root]!.kind === 'exists').map(f => f.root / 3)
  const last = git.length ? Math.min(...git) : Infinity
  const kept = (root: number) => root >= dirs.length * 3 || Math.floor(root / 3) <= last
  const projects = dirs.slice(0, last + 1)
  const enabled: Record<string, unknown> = {}
  for (let i = 0; i < settings.length; i++) {
    const setting = settings[i]!
    const dir = path.dirname(path.dirname(setting.dir))
    if (dir !== home && !projects.includes(dir)) continue
    const file = files.find(f => f.root === settingsStart + i)
    Object.assign(enabled, jsonObject(file?.text).enabledPlugins)
  }
  const installed = files.find(f => f.root === roots.length - 1)
  const plugins = await claudePluginCommands(collect, jsonObject(installed?.text).plugins, enabled, projects)
  return { commands: [...commandsOf(roots, files.filter(f => kept(f.root))), ...plugins.commands], denied: denied.some(kept) || plugins.denied }
}

// Parse only metadata files, never ~/.claude.json (which also holds credentials).
function jsonObject(text?: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text || '')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

// Installed versions only: scanning the cache would also offer disabled plugins
// and obsolete versions. Settings override from user to project to local.
async function claudePluginCommands(collect: (roots: SlashRoot[]) => Promise<SlashFiles>, installed: unknown, enabled: Record<string, unknown>, projects: string[]) {
  const plugins: { name: string, dir: string }[] = []
  if (installed && typeof installed === 'object' && !Array.isArray(installed)) {
    for (const [id, records] of Object.entries(installed)) {
      if (enabled[id] !== true || !Array.isArray(records)) continue
      const applicable = records.filter(r => r && typeof r.installPath === 'string' && path.isAbsolute(r.installPath)
        && (r.scope === 'user' || ((r.scope === 'project' || r.scope === 'local') && projects.includes(r.projectPath))))
      // A matching project install takes precedence over a user install.
      applicable.sort((a, b) => {
        const rank = (r: typeof a) => r.scope === 'user' ? Infinity : projects.indexOf(r.projectPath) * 2 + (r.scope === 'local' ? 0 : 1)
        return rank(a) - rank(b)
      })
      if (applicable[0]) plugins.push({ name: id.split('@')[0]!, dir: applicable[0].installPath })
    }
  }
  if (!plugins.length) return { commands: [], denied: false }
  const manifests = await collect(plugins.map(p => ({ dir: path.join(p.dir, '.claude-plugin/plugin.json'), kind: 'file' })))
  const roots: SlashRoot[] = []
  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i]!
    const manifest = jsonObject(manifests.files.find(f => f.root === i)?.text)
    const prefix = plugin.name + ':'
    roots.push({ dir: path.join(plugin.dir, 'skills'), kind: 'skills', prefix })
    const add = (value: unknown, kind: 'skills' | 'commands') => {
      for (const rel of typeof value === 'string' ? [value] : Array.isArray(value) ? value : []) {
        if (typeof rel !== 'string') continue
        const dir = path.resolve(plugin.dir, rel)
        if (!(kind === 'skills' && dir === path.resolve(plugin.dir)) && !dir.startsWith(path.resolve(plugin.dir) + path.sep)) continue
        // A declared skills path may be a collection or one skill directory.
        roots.push({ dir, kind: kind === 'commands' && rel.endsWith('.md') ? 'file' : kind, prefix, includeRoot: kind === 'skills' })
      }
    }
    add(manifest.skills, 'skills')
    add(manifest.commands ?? './commands', 'commands')
  }
  const found = await collect(roots)
  // Explicit command files use the same metadata and naming as directory entries.
  const commands = commandsOf(roots, found.files)
  for (const f of found.files) {
    const root = roots[f.root]!
    if (root.kind !== 'file') continue
    commands.push(...commandsOf([{ ...root, kind: 'commands' }], [{ ...f, root: 0, rel: path.basename(root.dir) }]))
  }
  return { commands, denied: found.denied.length > 0 }
}

export async function slashCommands(opts: { key: string, fs: MachineFs, exec?: ShellExec | null, home: string, kind: string, cwd: string | null }): Promise<SlashResult> {
  const { fs, exec, home, kind, cwd } = opts
  const id = `${opts.key}|${kind}|${cwd || ''}`
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < TTL) return hit.result
  const collect = (roots: SlashRoot[]) => (exec ? collectRemote(exec, roots) : collectLocal(fs, roots))
  let roots: SlashRoot[] = []
  let builtin: [string, string, string?][] = []
  const extra: SlashCommand[] = []
  let denied = false
  if (kind === 'claude') {
    builtin = CLAUDE_BUILTIN
    const r = await claudeCommands(collect, home, cwd)
    extra.push(...r.commands)
    denied = r.denied
  } else if (kind === 'codex') {
    builtin = CODEX_BUILTIN
    roots = [{ dir: path.join(home, '.codex/prompts'), kind: 'commands', depth: 0, prefix: 'prompts:' }]
  } else if (kind === 'cmd') {
    builtin = CMD_BUILTIN
  } else if (kind === 'omp') {
    builtin = OMP_BUILTIN
    const dirs = ompConfigDirs(home, cwd)
    const config: SlashRoot = { dir: path.join(home, '.omp/agent/config.yml'), kind: 'file' }
    roots = [...dirs.map(d => ({ dir: path.join(d, 'commands'), kind: 'commands' as const })), config, ...dirs.map(d => ({ dir: path.join(d, 'skills'), kind: 'skills' as const, prefix: 'skill:' }))]
    const { files } = await collect(roots)
    const cfg = files.find(f => roots[f.root] === config)
    const more = cfg ? ompSkillDirs(cfg.text, home).map(d => ({ dir: d, kind: 'skills' as const, prefix: 'skill:' })) : []
    const all = [...roots, ...more]
    const found = more.length ? [...files, ...(await collect(more)).files.map(f => ({ ...f, root: f.root + roots.length }))] : files
    const cmds = commandsOf(all, found)
    // Command shipped with omp (task/commands), after the user's ones, before the skills.
    const firstSkill = cmds.findIndex(c => c.source === 'skill')
    cmds.splice(firstSkill < 0 ? cmds.length : firstSkill, 0, { name: 'init', desc: 'Generate AGENTS.md for current codebase', source: 'command' })
    extra.push(...cmds)
    roots = []
  }
  if (roots.length) extra.push(...commandsOf(roots, (await collect(roots)).files))
  const result: SlashResult = { commands: mergeCommands(builtin, extra), ...(denied ? { denied: 'macos' as const } : {}) }
  cache.set(id, { at: Date.now(), result })
  return result
}

// omp config folders (project then user, ~/.omp/agent for omp
// itself), from highest to lowest priority: the first name found wins
// (mergeCommands).
function ompConfigDirs(home: string, cwd: string | null) {
  const bases = [...(cwd && cwd !== home ? [cwd] : []), home]
  return bases.flatMap(b => ['.omp', '.agents', '.agent', '.claude', '.codex'].map(r => path.join(b, b === home && r === '.omp' ? '.omp/agent' : r)))
}

// Text of omp's file commands (without frontmatter), the user's ones:
// omp sends it instead of "/name args", the conversation puts the command back
// (see parseOmp).
export interface CommandTemplate { name: string, body: string }
export async function ompCommandTemplates(fs: MachineFs, home: string): Promise<CommandTemplate[]> {
  const out: CommandTemplate[] = []
  for (const d of ompConfigDirs(home, null)) {
    for (const n of await ls(fs, path.join(d, 'commands'))) {
      if (!n.endsWith('.md')) continue
      const text = await read(fs, path.join(d, 'commands', n))
      const body = text && text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
      if (body) out.push({ name: n.slice(0, -3), body })
    }
  }
  return out
}
