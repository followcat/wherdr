// The pm folders (coordinators/, worktrees/, tasks/) under each machine's home:
// ~/.wherdr/pm, or WHERDR_PM_DIR (a path relative to the home) for a second
// install on the same machines (install-v3-beside-v2 sets it), so the two never
// share a coordinator's role files or a task's worktree.
export const PM_DIR = '.wherdr/pm'
export const pmDir = (v = process.env.WHERDR_PM_DIR) =>
  v && /^[\w.-]+(\/[\w.-]+)*$/.test(v) && !v.split('/').some(s => s === '.' || s === '..') ? v : PM_DIR
