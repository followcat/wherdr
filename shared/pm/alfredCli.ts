// `wherdr alfred …`: Alfred's own commands, to read and change wherdr's
// projects, coordinators and settings. Pure: the parser, the command table
// (also written in Alfred's AGENTS.md) and the "show, then do" text; the
// server (server/utils/alfredCli.ts) reads and writes.
import type { SyncedSetting } from '../settings'
import { MERGE_BY, type MergeBy } from './workflow'
import { READY_SORTS } from '../spaces'
import { THEMES } from '../../app/utils/themes'
import { FOCUS_BORDERS } from '../../app/utils/focusBorder'
import { BACKDROPS } from '../../app/utils/backdrop'

// The settings Alfred may change, each with the values the app reads (any
// other value would be ignored by it). Lists (groups, hidden agents, folds…)
// are changed in wherdr's Settings only.
const ON_OFF = ['1', '0']
export const SETTING_VALUES: Partial<Record<SyncedSetting, readonly string[]>> = {
  'theme': THEMES.map(t => t.id), 'focusBorder': FOCUS_BORDERS, 'backdrop': BACKDROPS, 'backdropPackets': ['on', 'off'],
  'machineBar': ON_OFF, 'compactListV2': ON_OFF,
  'showShells': ON_OFF, 'showCounters': ON_OFF, 'showQuotas': ON_OFF, 'quotaDisplay': ['left', 'used'],
  'autoReorderReady': ON_OFF, 'readySort': READY_SORTS,
  'typewriterSpeed': ['off', 'fast', 'medium', 'slow'], 'encryptedText': ON_OFF, 'replyStyle': ['icon', 'text', 'list'], 'defaultViewMode': ['chat', 'term'],
  'wherdr.files.hidden': ON_OFF, 'wherdr.files.md': ['rendered', 'source'],
}
const settable = (k: string): k is SyncedSetting => Object.hasOwn(SETTING_VALUES, k)

export type AlfredCommand =
  | { name: 'help' | 'projects' | 'templates' | 'machines' | 'coordinators' | 'settings' }
  | { name: 'project', key: string }
  | { name: 'coordinator open', key: string }
  // Changes: a dry run unless apply.
  | { name: 'project add', apply: boolean, input: { key: string, machine: string, path: string, name?: string, template?: string } }
  | { name: 'project template', apply: boolean, key: string, template: string } // '' clears it
  | { name: 'coordinator start', apply: boolean, key: string, program?: 'claude' | 'codex' }
  // No change given: the project's guards are shown.
  | { name: 'project guards', apply: boolean, key: string, change: { protect?: string[], mergeProtected?: MergeBy, mergeOthers?: MergeBy, contributorPrs?: 'off' | 'others' | 'all' } }
  | { name: 'setting set', apply: boolean, key: SyncedSetting, value: string }

// One table for the parser's usage errors, `help` and AGENTS.md.
export const ALFRED_COMMANDS: { usage: string, does: string }[] = [
  { usage: 'projects', does: 'whether projects are on, and each project (key, name, machine, folder, template)' },
  { usage: 'project <KEY>', does: 'one project, its coordinator and its tasks by state' },
  { usage: 'templates', does: 'the saved templates' },
  { usage: 'machines', does: 'the machines herdr-core knows (key, label, status); the key "" is this machine' },
  { usage: 'coordinators', does: 'each coordinator: its agent and whether it runs' },
  { usage: 'coordinator open <KEY>', does: 'the link that opens a running project coordinator, to give the user' },
  { usage: 'settings', does: 'the synced settings, their values, and the values each one Alfred may change accepts (1 = on, 0 = off)' },
  { usage: 'project add <KEY> --machine <key> --path <folder> [--name <name>] [--template <id>]', does: 'add a project: a git folder on a machine' },
  { usage: 'project template <KEY> <id|none>', does: 'give the project a template, or none' },
  { usage: 'project guards <KEY> [--protect <branch,branch|none>] [--merge-protected user|engine] [--merge-others user|engine] [--contributor-prs off|others|all]', does: 'the project\'s guards: protected branches, who merges into them and into the others (user: the user, engine: wherdr), and whether its coordinator may merge an outside contributor\'s PR after the user\'s yes (others: not into a branch reserved for the user; all: into any); without an option, shown only. A project coordinator never changes them' },
  { usage: 'coordinator start <KEY> [--program claude|codex]', does: 'start the project\'s coordinator, with its harness\'s default model (a new conversation replaces a running one)' },
  { usage: 'setting set <key> <value>', does: 'change a setting to one of the values `settings` lists for it' },
]

const KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}$/
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const FLAGS: Record<string, string[]> = {
  'project add': ['machine', 'path', 'name', 'template'],
  'coordinator start': ['program'],
  'project guards': ['protect', 'merge-protected', 'merge-others', 'contributor-prs'],
}

export const CHANGES = ['project add', 'project template', 'project guards', 'coordinator start', 'setting set']
const usage = (verb: string) => ({ error: `usage: wherdr alfred ${ALFRED_COMMANDS.find(c => c.usage.startsWith(verb))!.usage}${CHANGES.includes(verb) ? ' [--apply]' : ''}` })

// argv after `wherdr alfred` → a command, or the reason it is not one.
// --apply (no value) makes a change; without it, the change is only shown.
export function parseAlfredCommand(argv: unknown): AlfredCommand | { error: string } {
  if (!Array.isArray(argv) || !argv.every(a => typeof a === 'string')) return { error: 'argv must be a list of words' }
  const words: string[] = [], flags: Record<string, string> = {}
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--apply') { apply = true; continue }
    if (!a.startsWith('--')) { words.push(a); continue }
    const v = argv[i + 1] as string | undefined
    if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` }
    flags[a.slice(2)] = v
    i++
  }
  const [w0 = '', w1 = '', w2, w3, ...rest] = words
  const verb = `${w0} ${w1}`
  const extra = Object.keys(flags).find(f => !(FLAGS[verb] ?? []).includes(f))
  if (extra) return { error: `unknown option --${extra}` }
  if (apply && !CHANGES.includes(verb)) return { error: '--apply is for a change only' }
  const key = (k: string | undefined) => (k && KEY_RE.test(k) ? k.toUpperCase() : '')

  if (['help', 'projects', 'templates', 'machines', 'coordinators', 'settings'].includes(w0) && !w1)
    return { name: w0 as 'help' }
  if (w0 === 'project' && words.length === 2 && !['add', 'template', 'guards'].includes(w1)) return key(w1) ? { name: 'project', key: key(w1) } : usage('project <KEY>')
  if (verb === 'coordinator open') return key(w2) && !w3 ? { name: verb, key: key(w2) } : usage(verb)
  if (verb === 'project add') {
    const { machine, path, name, template } = flags
    if (!key(w2) || w3 || machine === undefined || !path) return usage(verb)
    if (template !== undefined && !ID_RE.test(template)) return { error: '--template is a template id (see wherdr alfred templates)' }
    return { name: verb, apply, input: { key: key(w2), machine, path, ...(name ? { name } : {}), ...(template ? { template } : {}) } }
  }
  if (verb === 'project template') {
    if (!key(w2) || !w3 || rest.length) return usage(verb)
    if (w3 !== 'none' && !ID_RE.test(w3)) return { error: 'The template is a template id, or none' }
    return { name: verb, apply, key: key(w2), template: w3 === 'none' ? '' : w3 }
  }
  if (verb === 'project guards') {
    const { protect, 'merge-protected': mp, 'merge-others': mo, 'contributor-prs': cp } = flags
    if (!key(w2) || w3) return usage(verb)
    if (cp !== undefined && !['off', 'others', 'all'].includes(cp)) return { error: '--contributor-prs is off, others or all' }
    if ([mp, mo].some(v => v !== undefined && !MERGE_BY.includes(v as MergeBy))) return { error: '--merge-protected and --merge-others are user or engine' }
    const branches = protect === undefined ? undefined : protect === 'none' ? [] : protect.split(',').map(b => b.trim()).filter(Boolean)
    return { name: verb, apply, key: key(w2), change: { ...(branches ? { protect: branches } : {}), ...(mp ? { mergeProtected: mp as MergeBy } : {}), ...(mo ? { mergeOthers: mo as MergeBy } : {}), ...(cp ? { contributorPrs: cp as 'off' } : {}) } }
  }
  if (verb === 'coordinator start') {
    // A program only: it runs with its harness's default model.
    const { program } = flags
    if (!key(w2) || w3) return usage(verb)
    if (program !== undefined && program !== 'claude' && program !== 'codex') return { error: '--program is claude or codex' }
    return { name: verb, apply, key: key(w2), ...(program ? { program: program as 'claude' | 'codex' } : {}) }
  }
  if (verb === 'setting set') {
    if (!w2 || w3 === undefined || rest.length) return usage(verb)
    if (!settable(w2)) return { error: `${w2} is not a setting Alfred changes: one of ${Object.keys(SETTING_VALUES).join(', ')}; the others are changed in wherdr's Settings` }
    if (!SETTING_VALUES[w2]!.includes(w3)) return { error: `${w3} is not a value of ${w2}: one of ${SETTING_VALUES[w2]!.join(', ')}` }
    return { name: verb, apply, key: w2, value: w3 }
  }
  return { error: `unknown command: ${words.join(' ') || '(none)'} (see wherdr alfred help)` }
}

// What a change does, shown before it is made: the lines, the command that
// makes it, and where it reaches (a remote machine is named).
export interface AlfredPlan { change: string[], remote?: string }
export function dryRun(argv: string[], plan: AlfredPlan) {
  return {
    dryRun: true, change: plan.change,
    ...(plan.remote ? { remote: `This reaches machine ${plan.remote}: make it only if the user asked for it` } : {}),
    next: `Show this to the user; only after their yes, run: wherdr alfred ${[...argv.filter(a => a !== '--apply'), '--apply'].map(quoteWord).join(' ')}`,
  }
}
const quoteWord = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)

export const alfredCommandList = () => ALFRED_COMMANDS.map(c => `- \`wherdr alfred ${c.usage}${CHANGES.some(v => c.usage.startsWith(v)) ? ' [--apply]' : ''}\`: ${c.does}`)
