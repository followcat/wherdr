// Named agents (Settings › Agents): a name for a command on some machines, such
// as `omp-sub` for `omp-sub --thinking medium`, a wrapper script on the PATH
// that runs omp with another account. wherdr reads its transcripts, choices and
// status as its program's. Kept in the synced settings (namedAgents): a name and
// a command line only, never a secret (the wrapper reads its key itself).
import { PROGRAMS } from './workflow'

export interface NamedAgent { name: string, program: string, command: string, machines: string[] }

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/
// The executable: a word on the PATH or a path, nothing the shell would read.
const EXE_RE = /^[A-Za-z0-9._/~+-]+$/
// A key written in the command, as an assignment or an option (--api-key VALUE,
// --token=…): refused, it belongs in the wrapper script.
const SECRET_RE = /api[_-]?key|token|secret|passw(or)?d|credential|\bsk-[A-Za-z0-9]/i
// Options are split on spaces and each passed quoted, as typed: a quote or a
// backslash would reach the program as such, so none is accepted.
const QUOTE_RE = /['"\\]/
export const COMMAND_MAX = 200

// Why a named agent cannot be kept (others: the names already taken), or undefined.
export function namedAgentError(a: NamedAgent, others: readonly string[] = []): string | undefined {
  if (!AGENT_NAME_RE.test(a.name)) return 'Name: lowercase letters, digits, . _ - (up to 32)'
  if ((PROGRAMS as readonly string[]).includes(a.name)) return `"${a.name}" is a program's name: choose another`
  if (others.includes(a.name)) return `"${a.name}" is taken`
  if (!(PROGRAMS as readonly string[]).includes(a.program)) return `Program: ${PROGRAMS.join(', ')}`
  const words = commandWords(a.command)
  if (!words.length || a.command.length > COMMAND_MAX || /[\n\r]/.test(a.command)) return `Command: an executable and its options, up to ${COMMAND_MAX} characters`
  if (!EXE_RE.test(words[0]!)) return 'Command: its first word is an executable on the PATH or a path'
  if (SECRET_RE.test(a.command)) return 'No key in the command: the wrapper script reads it (from the keychain)'
  if (QUOTE_RE.test(a.command)) return 'Command: no quotes; options are split on spaces (an option with spaces goes in the wrapper script)'
  if (!a.machines.length) return 'Choose at least one machine'
}

export const commandWords = (command: string) => command.trim().split(/\s+/).filter(Boolean)

// The stored list: valid entries only, first of each name.
export function readNamedAgents(raw: string | null | undefined): NamedAgent[] {
  let v: unknown
  try { v = raw ? JSON.parse(raw) : [] } catch { return [] }
  if (!Array.isArray(v)) return []
  const out: NamedAgent[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') continue
    const { name, program, command, machines } = x as Record<string, unknown>
    if (typeof name !== 'string' || typeof program !== 'string' || typeof command !== 'string' || !Array.isArray(machines)) continue
    const a = { name, program, command: command.trim(), machines: [...new Set(machines.filter((m): m is string => typeof m === 'string'))] }
    if (!namedAgentError(a, out.map(o => o.name))) out.push(a)
  }
  return out
}

// An agent as the workflow prefs name it: a program, or a named agent's name.
// named undefined: the list is not known here (a template checked alone): a
// well-formed name passes, its program unknown.
export type AgentRef = { program: string, agent?: string, command?: string }
export function resolveAgent(name: string, named?: readonly NamedAgent[]): AgentRef | { reason: string } | { unknown: string } {
  if ((PROGRAMS as readonly string[]).includes(name)) return { program: name }
  const a = named?.find(x => x.name === name)
  if (a) return { program: a.program, agent: a.name, command: a.command }
  if (!named && AGENT_NAME_RE.test(name)) return { unknown: name }
  return { reason: `The engine cannot start "${name}": claude, codex, omp or a named agent of Settings › Agents` }
}

// Why a machine cannot run the task's named agents (those it lacks), or undefined.
export function agentsMissing(names: readonly string[], named: readonly NamedAgent[], machine: string): string | undefined {
  const lacking = [...new Set(names)].filter(n => named.find(a => a.name === n && !a.machines.includes(machine)))
  return lacking.length ? `no named agent ${lacking.join(', ')} (Settings › Agents)` : undefined
}
