// The project coordinator: the `wherdr pm` commands its token allows, the
// rights checked on each, and the role files written in its own folder. Pure:
// the server (server/utils/pmCoordinator.ts) reads and writes.
import type { Project } from './project'
import type { Template } from './workflow'
import { CHOICES, type Choice } from './verdict'
import { currentStep, onEvent, planSteps, type PlannedStep, type StepEvent, type StepState } from './steps'

// The agent of a coordinator: the project's default, and the one its kept
// conversation ran with (changing it starts a new conversation, never a
// resume of another program's session).
export interface CoordinatorAgent { program: 'claude' | 'codex', model: string }
export const COORDINATOR_AGENTS: CoordinatorAgent[] = [
  { program: 'claude', model: 'opus' }, { program: 'claude', model: 'sonnet' }, { program: 'codex', model: 'gpt-6-sol' },
]
export const sameAgent = (a?: CoordinatorAgent, b?: CoordinatorAgent) => !!a && !!b && a.program === b.program && a.model === b.model
export const agentName = (a: CoordinatorAgent) => (a.program === 'claude'
  ? `Claude ${a.model.charAt(0).toUpperCase()}${a.model.slice(1)}`
  : `Codex ${a.model.replace(/^gpt/i, 'GPT')}`)

// A template change the coordinator proposed: the user accepts or refuses it
// in the interface; only an accepted one is saved and goes to the template's log.
// base: the template version its diff was made against.
export interface Proposal { template: Template, diff: string, at: number, base: number, said?: string }
// What became of the last one, for the coordinator's `template show`.
export type ProposalOutcome = 'accepted' | 'refused' | 'outdated: the template changed since, propose again'

// GET /api/pm/coordinators: one per project.
export interface CoordinatorView { project: string, name: string, agent: CoordinatorAgent, ran?: CoordinatorAgent, terminal?: string, proposal?: Omit<Proposal, 'template' | 'base'> }

// Where the coordinator's current turn comes from: a message the user sent
// from the interface, an engine wake, or nothing known (refused like a wake).
export type Turn = 'user' | 'wake' | 'none'

export type Command =
  | { name: 'list' } | { name: 'plan' } | { name: 'template show' }
  | { name: 'show', task: string }
  | { name: 'template edit' } // the new template comes as the call's input (JSON)
  | { name: 'task tag', task: string, text: string }
  | { name: 'task link', task: string, url: string, label: string }
  | { name: 'step done', task: string, userSaid?: string, link?: string }
  | { name: 'task decide', task: string, choice: Choice, reason: string }
  | { name: 'ack', wakes: string[] } | { name: 'autopilot show' }
  | { name: 'tell', task: string, text: string }

// One table for the parser, the skill and the role file.
export const COMMANDS: { usage: string, does: string }[] = [
  { usage: 'list', does: 'the project\'s tasks, their step and what waits for the user' },
  { usage: 'show <task>', does: 'one task, its plan and its log' },
  { usage: 'plan', does: 'the resolved plan of each task type' },
  { usage: 'template show', does: 'the project\'s template (JSON)' },
  { usage: 'template edit < template.json', does: 'propose a new template; only in a turn that comes from the user, guards unchanged; the user accepts or refuses its diff in wherdr' },
  { usage: 'task tag <task> <text>', does: 'a short tag on the card (a ticket key, a client)' },
  { usage: 'task link <task> <url> --label <label>', does: 'a link on the card (PR, ticket, pipeline)' },
  { usage: 'step done <task> [--link <url>]', does: 'end the task\'s current step when you hold it (holder: coordinator)' },
  { usage: 'step done <task> --user-said "<their words>"', does: 'end a step that waits for the user, with the user\'s own words; only in a turn that comes from the user' },
  { usage: 'task decide <task> <choice> --reason "<one sentence>"', does: 'after N send-backs, pick one of the engine\'s options' },
  { usage: 'ack <wake> [<wake>…]', does: 'say you handled an Autopilot wake (each wake ends with its id); unacked, it comes back once, then the user is told' },
  { usage: 'autopilot show', does: 'your autopilot\'s goal, hours, and what is left of today\'s limits' },
  { usage: 'tell <task> "<text>"', does: 'a message to the task\'s agent; in a wake, only to answer its question (a permission request is the user\'s)' },
]

const TASK_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/
const URL_RE = /^https?:\/\/\S{1,2000}$/

// argv after `wherdr pm` → a command, or the reason it is not one.
export function parseCommand(argv: unknown): Command | { error: string } {
  if (!Array.isArray(argv) || !argv.every(a => typeof a === 'string')) return { error: 'argv must be a list of words' }
  const words: string[] = [], flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (!a.startsWith('--')) { words.push(a); continue }
    const v = argv[i + 1] as string | undefined
    if (v === undefined) return { error: `${a} needs a value` }
    flags[a.slice(2)] = v
    i++
  }
  const [w0, w1, w2, w3, ...rest] = words
  const verb = [w0, w1].join(' '), task = w2 ?? ''
  const usage = (u: string) => ({ error: `usage: wherdr pm ${COMMANDS.find(c => c.usage.startsWith(u))!.usage}` })
  const known = (...k: string[]) => Object.keys(flags).find(f => !k.includes(f))
  const extra = known(...({ 'task link': ['label'], 'step done': ['user-said', 'link'], 'task decide': ['reason'] }[verb] ?? []))
  if (extra) return { error: `unknown option --${extra}` }
  if (w0 === 'ack') return words.length > 1 && words.slice(1).every(w => /^[0-9a-f]{8}$/.test(w)) ? { name: 'ack', wakes: words.slice(1) } : usage('ack')
  if (verb === 'autopilot show') return w2 ? { error: `unexpected argument: ${w2}` } : { name: verb }
  if (w0 === 'tell') {
    const text = words.slice(2).join(' ').trim()
    return w1 && TASK_RE.test(w1) && text && text.length <= 4000 ? { name: 'tell', task: w1, text } : usage('tell')
  }
  if (w0 === 'list' || w0 === 'plan') return w1 ? { error: `unexpected argument: ${w1}` } : { name: w0 }
  if (w0 === 'show') return w1 && TASK_RE.test(w1) && !w2 ? { name: 'show', task: w1 } : usage('show')
  if (verb === 'template show' || verb === 'template edit') return w2 ? { error: `unexpected argument: ${w2}` } : { name: verb }
  if (verb !== 'task tag' && verb !== 'task link' && verb !== 'step done' && verb !== 'task decide') return { error: `unknown command: ${words.join(' ') || '(none)'} (see wherdr pm help)` }
  if (!TASK_RE.test(task) || rest.length) return usage(verb)
  if (verb === 'task tag') {
    const text = (w3 ?? '').trim()
    return text && text.length <= 40 ? { name: verb, task, text } : { error: 'A tag is 1 to 40 characters' }
  }
  if (verb === 'task link') {
    const label = (flags.label ?? '').trim()
    if (!w3 || !URL_RE.test(w3)) return { error: 'A link is an http(s) URL' }
    return label && label.length <= 40 ? { name: verb, task, url: w3, label } : usage(verb)
  }
  if (verb === 'step done') {
    if (w3) return usage(verb)
    if (flags.link !== undefined && !URL_RE.test(flags.link)) return { error: 'A link is an http(s) URL' }
    const said = flags['user-said']?.trim()
    if (flags['user-said'] !== undefined && !said) return { error: '--user-said needs the user\'s words' }
    return { name: verb, task, ...(said ? { userSaid: said.slice(0, 500) } : {}), ...(flags.link ? { link: flags.link } : {}) }
  }
  const choice = w3 as Choice, reason = (flags.reason ?? '').trim()
  if (!CHOICES.includes(choice)) return { error: `The choice is one of ${CHOICES.join(', ')}` }
  // One sentence, kept in the task's log.
  if (!reason || reason.length > 300 || reason.includes('\n')) return { error: '--reason is one sentence (300 characters at most)' }
  return { name: verb, task, choice, reason }
}

// JSON with its keys sorted, to compare two values whatever their order.
const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`
  : JSON.stringify(v ?? null)
const guardsOf = (t: Template | null) =>
  canon({ project: t?.guards, types: Object.fromEntries(Object.entries(t?.taskTypes ?? {}).map(([k, tt]) => [k, tt.guards])) })

// Why the coordinator may not save `next` over `old`, or undefined. Guards
// change only through the user's own gesture in the interface.
export function templateEditRefusal(old: Template | null, next: Template, turn: Turn): string | undefined {
  if (turn !== 'user') return 'template edit is only for a turn that comes from the user: propose the change and wait for their yes'
  if (!old) return 'The project has no template: the user picks one in Settings › Projects'
  if (next?.id !== old.id) return `The coordinator edits its project's template only (${old.id})`
  if (guardsOf(old) !== guardsOf(next)) return 'Guards (protected branches, who merges) change only through the user\'s gesture in Settings › Projects, never with the coordinator\'s token'
}

// `step done` → the engine's event, or why it is refused. --user-said ends a
// step that waits for the user, only in a turn that comes from them; otherwise
// the coordinator ends only a step it holds.
export function stepDoneEvent(step: PlannedStep | undefined, cmd: { userSaid?: string, link?: string }, turn: Turn): StepEvent | { refused: string } {
  if (!step) return { refused: 'The task has no current step' }
  if (cmd.userSaid !== undefined) {
    if (turn !== 'user') return { refused: '--user-said is only for a turn that comes from the user, not a wake' }
    if (step.ends !== 'user') return { refused: `Step "${step.id}" does not wait for the user` }
    return { kind: 'user' }
  }
  if (step.holder !== 'coordinator') return { refused: `Step "${step.id}" is held by the ${step.holder ?? 'none'}, not the coordinator` }
  return { kind: 'report', from: 'coordinator', ...(cmd.link ? { evidence: { link: cmd.link } } : {}) }
}

// How the coordinator starts, in its own folder. Claude: the repo added with
// --add-dir, its edits denied in the folder's .claude/settings.json. Codex:
// its --add-dir makes a folder writable, so none. Its `workspace-write`
// sandbox has no network, which `wherdr pm` needs: a permission profile given
// only by -c (nothing in ~/.codex) extends :workspace (reads everywhere, writes
// in its folder and temp folders) with the network on.
export function coordinatorArgs(program: 'claude' | 'codex', model: string, folder: string, repo: string): string[] {
  return program === 'claude'
    ? ['claude', '--model', model, '--add-dir', repo]
    : ['codex', '--model', model, '-C', folder, '-c', 'default_permissions="wherdr"', '-c', 'permissions.wherdr.extends=":workspace"', '-c', 'permissions.wherdr.network.enabled=true']
}

// `wherdr` in the coordinator's folder (bin/, first in its PATH): the project's
// machine may have no wherdr installed, and a build ships none. sh, base64 and
// curl only; every word goes base64-encoded, so any text is safe in the JSON.
export const WHERDR_SCRIPT = `#!/bin/sh
# wherdr pm, for this project's coordinator (written by wherdr at its start).
[ "$1" = pm ] || { echo "wherdr: only 'wherdr pm <command>' works here" >&2; exit 2; }
shift
b64() { base64 | tr -d '\\n'; }
body='{"argv64":[' sep=
for a in "$@"; do body="$body$sep\\"$(printf %s "$a" | b64)\\"" sep=,; done
body="$body]"
[ "$1 $2" = "template edit" ] && body="$body,\\"input64\\":\\"$(b64)\\""
out=$(mktemp) || exit 1
code=$(printf '%s}' "$body" | curl -sS -o "$out" -w '%{http_code}' -X POST --data-binary @- \\
  -H 'content-type: application/json' -H "origin: $WHERDR_URL" -H "authorization: Bearer $WHERDR_PM_TOKEN" "$WHERDR_URL/api/pm/cli")
cat "$out"; echo; rm -f "$out"
[ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 300 ]
`

// The changed lines of two templates, as JSON: what the coordinator shows the user.
export function templateDiff(old: Template | null, next: Template): string {
  const lines = (t: Template | null) => JSON.stringify({ ...t, version: undefined }, null, 2).split('\n') // the version is the store's
  const a = lines(old), b = lines(next)
  let i = 0, j = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
  return [...a.slice(i, a.length - j).map(l => `- ${l}`), ...b.slice(i, b.length - j).map(l => `+ ${l}`)].join('\n')
}

// What the engine tells the coordinator on a tick: its step's instructions
// once when the step starts, then each recheck. `told` marks the step start
// already announced.
export function coordinatorWake(plan: PlannedStep[], state: StepState, now: number): { state: StepState, texts: string[] } {
  if (!state.started || state.done) return { state, texts: [] }
  const r = onEvent(plan, state, { kind: 'tick' }, now)
  const texts = r.effects.flatMap(e => (e.kind === 'instruct' && e.holder === 'coordinator' ? [e.text] : []))
  const step = currentStep(plan, r.state)
  if (step?.holder !== 'coordinator' || state.told === state.since) return { state: r.state, texts }
  return { state: { ...r.state, told: state.since }, texts: texts.length ? texts : [step.text] }
}

const stepLine = (s: PlannedStep) => `- ${s.id} (${s.column ?? s.id}): ${[
  `holder ${s.holder ?? 'none'}`, s.ends && `ends ${s.ends}`, s.userLabel && `button "${s.userLabel}"`, s.evidence?.length && `needs ${s.evidence.join(', ')}`,
  s.action && `action ${s.action.kind} ${s.action.target ?? s.action.base ?? ''}`.trim(), s.guarded && 'guarded: only the user merges',
  s.sendBack && `sends back to ${s.sendBack} (${s.rounds ?? 2} rounds)`, s.recheck && `recheck ${s.recheck}`, s.timeout && `timeout ${s.timeout}`,
].filter(Boolean).join(', ')}`

const commandList = COMMANDS.map(c => `- \`wherdr pm ${c.usage}\`: ${c.does}`)

// The files of the coordinator's folder, path → text. Nothing outside it.
export function roleFiles(p: Project, t: Template | null, examples: Template[]): Record<string, string> {
  const plans = t ? Object.entries(t.taskTypes).flatMap(([type]) => [`### ${type}`, ...planSteps(t, { type }).map(stepLine), '']) : ['(no template yet)']
  const own = t ? [t.instructions, ...Object.entries(t.taskTypes).map(([k, tt]) => tt.instructions && `${k}: ${tt.instructions}`)].filter(Boolean).map(s => `- ${s}`) : []
  const agents = [
    `# Coordinator of project ${p.name} (${p.key})`, '',
    `You coordinate project ${p.key} only. Its repository is ${p.path}: read it, never change it; task agents do the work in their own worktrees.`,
    'Messages that start with "Autopilot:" are wakes sent by the engine; the others come from the user. The server knows which, and refuses what a wake may not do.', '',
    '## Commands (your token: this project only)', '', ...commandList, '',
    'Every change you make is written to the task\'s or the template\'s log with your name.',
    `Quote a file as inline code with its absolute path (\`${p.path.replace(/\/$/, '')}/README.md\`): the user's interface makes it a link.`, '',
    '## What you never do', '',
    '- change a guard (protected branches, who merges): the user does it in Settings › Projects;',
    '- end a step that waits for the user unless they just told you so (`--user-said` with their words);',
    '- edit the template on your own: only the user\'s request starts a proposal, and only their yes in wherdr saves it;',
    '- pass a critical finding with proof, or a send-back whose next step is a guarded merge: those go to the user;',
    '- approve, merge, change settings or your autopilot\'s limits; answer a permission request: those are the user\'s.', '',
    'Each Autopilot wake ends with its id: once you have handled it, run `wherdr pm ack <id>`. The engine already fixes PR bases, re-runs CI, retries pushes, catches up branches, sends red CI back and merges what the branch rule allows: leave those to it.', '',
    '## Plans of this project\'s task types', '', `Template: ${t ? `${t.id} v${t.version ?? 1}` : 'none'}`, '', ...plans,
    '## Turning a workflow request into steps', '',
    'wherdr imposes no workflow: it knows ordered steps, who holds each (worker, reviewer, coordinator, none), how it ends (report, verdict, user, action), the proofs it needs (evidence) and the user\'s guards. What an agent must do is plain text in `instructions`.',
    'When the user says "after each task, create the PR with my Bitbucket tool, then wait until I say it is merged", write a worker step with that instruction and `evidence: ["link"]`, then a step `{ holder: "none", ends: "user", userLabel: "Merged", action: { kind: "git.verify-merged", target } }`. "Watch the deploy" is a step you hold: `holder: "coordinator", ends: "report", recheck: "5m"`.',
    'Read the template, write the new one and run `template edit`: wherdr shows the user its diff, to accept or refuse; `template show` tells you which. Examples to copy from:', '',
    ...examples.map(e => `\`\`\`json\n${JSON.stringify(e)}\n\`\`\``), '',
    '## After N send-backs', '',
    'The engine sorts what is left and gives options. Pick one with `task decide` and one sentence of reason. When it gives no option, the choice is the user\'s: tell them.', '',
    '## The user\'s instructions', '', ...(own.length ? own : ['(none yet)']), '',
  ].join('\n')
  const skill = ['---', 'name: wherdr-pm', `description: Act on project ${p.key}'s board with the wherdr pm command (tasks, steps, tags, links, template).`, '---', '',
    '# wherdr pm', '', 'Your token is in WHERDR_PM_TOKEN; the server checks every right.', '', ...commandList, ''].join('\n')
  // Claude's Edit rule covers every file-writing tool.
  const deny = [`Edit(/${p.path.replace(/\/$/, '')}/**)`]
  return {
    'AGENTS.md': agents,
    'CLAUDE.md': '@AGENTS.md\n',
    '.claude/skills/wherdr-pm/SKILL.md': skill,
    '.claude/settings.json': `${JSON.stringify({ permissions: { deny } }, null, 2)}\n`,
    'bin/wherdr': WHERDR_SCRIPT,
  }
}
