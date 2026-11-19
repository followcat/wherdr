// A task's branch, from its project's Branch name template: {id} (WHR-12),
// {tag} (the card's ticket key, else its first tag, else the id), {type}
// (bugfix for a bug or fix task type, else feature) and {slug} (the title).
// The engine follows the branch the worker says it pushed instead.
// The Commit message template (commitMessageFor) takes the same fields and
// {title}, for a squash merge's commit title and git.land's merge commit.
import { isBranch } from './project'
import type { Task } from './run'

export const DEFAULT_BRANCH_NAME = 'task/{id}'
const FIELDS = ['id', 'tag', 'type', 'slug'] as const
const MESSAGE_FIELDS = [...FIELDS, 'title'] as const
type Fields = Record<(typeof MESSAGE_FIELDS)[number], string>
const SLUG_MAX = 40
const TICKET_RE = /^[A-Z][A-Z0-9_]*-\d+$/

// Why a template cannot name branches, or undefined.
export function branchNameError(tpl: string): string | undefined {
  if (tpl.length > 80) return 'at most 80 characters'
  const unknown = [...tpl.matchAll(/\{([^}]*)\}/g)].map(m => m[1]!).find(f => !(FIELDS as readonly string[]).includes(f))
  if (unknown !== undefined) return `unknown field {${unknown}}: use {id}, {tag}, {type} or {slug}`
  if (!/\{(id|tag)\}/.test(tpl)) return 'needs {id} or {tag}, so each task has its own branch'
  if (!isBranch(fill(tpl, { id: 'X-1', tag: 'X-1', type: 'feature', slug: 'x', title: '' }))) return 'not a valid branch name'
}

// Why a template cannot write commit messages, or undefined.
export function commitMessageError(tpl: string): string | undefined {
  if (tpl.length > 120) return 'at most 120 characters'
  if (/[\r\n]/.test(tpl)) return 'one line'
  const unknown = [...tpl.matchAll(/\{([^}]*)\}/g)].map(m => m[1]!).find(f => !(MESSAGE_FIELDS as readonly string[]).includes(f))
  if (unknown !== undefined) return `unknown field {${unknown}}: use {tag}, {id}, {title}, {type} or {slug}`
}

const fill = (tpl: string, v: Partial<Fields>) =>
  tpl.replace(/\{(id|tag|type|slug|title)\}/g, (_, f: keyof Fields) => v[f] ?? '')

// Lower case ASCII words joined by -, cut on a word under SLUG_MAX.
export function slugOf(title: string) {
  const s = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (s.length <= SLUG_MAX) return s
  const cut = s.slice(0, SLUG_MAX + 1)
  return (cut.lastIndexOf('-') > 0 ? cut.slice(0, cut.lastIndexOf('-')) : cut.slice(0, SLUG_MAX)).replace(/-$/, '')
}

// A tag kept to the characters a branch takes.
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '')

type Named = Pick<Task, 'id' | 'title' | 'type' | 'tags'>
// The card's ticket key, else its first tag, else '' (kept to branch characters).
export const tagOf = (task: Named) => {
  const tags = (task.tags ?? []).map(safe).filter(Boolean)
  return tags.find(t => TICKET_RE.test(t)) ?? tags[0] ?? ''
}
const fieldsOf = (task: Named): Fields =>
  ({ id: task.id, tag: tagOf(task), type: /bug|fix/i.test(task.type) ? 'bugfix' : 'feature', slug: slugOf(task.title), title: task.title.trim() })

export function branchFor(tpl: string | undefined, task: Named): string {
  const fallback = fill(DEFAULT_BRANCH_NAME, { id: task.id })
  if (!tpl || branchNameError(tpl)) return fallback
  const v = fieldsOf(task)
  const name = fill(tpl, { ...v, tag: v.tag || task.id })
    // An empty field leaves no stray separator (feature/WHR-1- → feature/WHR-1).
    .replace(/[-_.]+(?=\/|$)/g, '').replace(/\/[-_.]+/g, '/').replace(/\/{2,}/g, '/')
  return isBranch(name) ? name : fallback
}

// A commit message from the project's template, or undefined (no template:
// the host's or git's own message). An empty field leaves no dangling
// separator: '{tag}: {title}' without a tag is the title alone.
export function commitMessageFor(tpl: string | undefined, task: Named): string | undefined {
  if (!tpl?.trim() || commitMessageError(tpl)) return
  const msg = fill(tpl, fieldsOf(task))
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/^[\s:;,.|/#-]+|[\s:;,|/#-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
  return msg || undefined
}

const decoded = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

// The branch the worker says it pushed: a "Branch: <name>" line in its note,
// else a link's ?source=<branch> (a Bitbucket pull request link).
export function reportedBranch(note: string): string | undefined {
  const line = /^\s*branch:\s*`?([^\s`]+)`?\s*$/im.exec(note)?.[1]
  const source = /https?:\/\/\S+[?&]source=([^\s&#)>\]]+)/.exec(note)?.[1]
  const b = line ?? (source ? decoded(source) : undefined)
  return b && isBranch(b) ? b : undefined
}

// The branch a worker's report moves the task to, or undefined: the one it
// says it pushed, else one it checked out in the worktree. The worktree still
// on the branch it was made on (start) says nothing: a branch pushed without
// a checkout stays followed.
export function followedBranch(current: string, r: { note: string, branch?: string }, start: string): string | undefined {
  const b = reportedBranch(r.note) ?? (r.branch && r.branch !== start && isBranch(r.branch) ? r.branch : undefined)
  return b && b !== current ? b : undefined
}
