// "New" sheet › Project › Add: what a chosen folder is, and the name and key
// proposed from it.

// GET /api/pm/folder: the folder as it stands on its machine.
export interface FolderProbe { path: string, exists: boolean, git: boolean, empty: boolean }
// POST /api/pm/project from the sheet: create a missing folder, git init a
// new or empty one, take a folder without git as it is.
export interface FolderOptions { create?: boolean, gitInit?: boolean, plain?: boolean }
// git: a repository; new: created at start; empty: there, nothing in it;
// plain: files but no git (a folder of several projects, for instance).
export type FolderKind = 'git' | 'new' | 'empty' | 'plain'
export const folderKind = (p: FolderProbe): FolderKind => (!p.exists ? 'new' : p.git ? 'git' : p.empty ? 'empty' : 'plain')
// Only a new or empty folder offers `git init`: a folder with files stays as it is.
export const canGitInit = (k: FolderKind) => k === 'new' || k === 'empty'

// The folder's own name: "~/src/my-web/" → "my-web".
export const proposeName = (folder: string) => folder.replace(/\/+$/, '').split('/').pop()?.trim().slice(0, 80) || ''

// A key tasks are numbered with (WHR-12): 2 to 10 letters or digits, starting
// with a letter. Several words give their initials (my-web-app → MWA), one word
// its first letter and next consonants (wherdr → WHR), a short one itself (api → API). A taken key gets a digit.
export function proposeKey(name: string, taken: readonly string[] = []): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean)
  const first = words.findIndex(w => /^[A-Za-z]/.test(w))
  if (first < 0) return free('PRJ', taken)
  const rest = words.slice(first)
  let key = rest.length > 1 ? rest.map(w => w[0]).join('').slice(0, 4) : ''
  if (key.length < 2) {
    const w = rest[0]!.toUpperCase()
    key = w.length <= 3 ? w : (w[0]! + w.slice(1).replace(/[AEIOUY]/g, '')).slice(0, 3)
    if (key.length < 2) key = w.slice(0, 3)
    if (key.length < 2) key = `${key}P`
  }
  return free(key.toUpperCase(), taken)
}

function free(key: string, taken: readonly string[]) {
  if (!taken.includes(key)) return key
  for (let n = 2; n < 100; n++) {
    const k = `${key.slice(0, 10 - String(n).length)}${n}`
    if (!taken.includes(k)) return k
  }
  return key
}

// The project being added. template: a saved template's id, or example:<id>
// (an example, saved under its id at start).
export interface ProjectDraft { machine: string, path: string, name: string, key: string, template: string, gitInit: boolean, probe: FolderProbe | null }

// Whether the project will be a git repository: one already, or git init asked.
// Without git, no template: its tasks never start, its coordinator does the work.
export function draftGit(d: ProjectDraft) {
  const kind = d.probe ? folderKind(d.probe) : 'plain'
  return kind === 'git' || (canGitInit(kind) && d.gitInit)
}

// POST /api/pm/project for a draft whose folder was probed: git init only where
// it is offered, the folder created when missing.
export function draftBody(d: ProjectDraft, template: string) {
  const kind = d.probe ? folderKind(d.probe) : 'plain'
  return {
    key: d.key.trim(), name: d.name.trim(), machine: d.machine, path: d.probe?.path || d.path.trim(), template: draftGit(d) ? template : '',
    plain: true, create: kind === 'new', gitInit: canGitInit(kind) && d.gitInit,
  }
}
