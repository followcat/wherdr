import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project } from '../shared/pm/project'
import { workspaceInput, workspaceSkills } from '../shared/pm/workspace'
import { SKILLS_SCRIPT } from '../server/utils/pmLaunch'
import { createPmStore } from '../server/utils/pmStore'

const ws: Project = { key: 'WS', name: 'Work', machine: 'home', path: '~/work', git: false, kind: 'workspace', addedAt: 1, shared: { machines: ['big'], clones: { big: '/srv/work/' } } }
const member: Project = { key: 'PAY', name: 'payroll-api', machine: 'home', path: '~/work/payroll-api', workspace: 'WS', addedAt: 2 }
const root: Project = { ...member, key: 'ROOT', path: '~/work' }

describe('workspace root skills', () => {
  it('a member task links the root\'s .claude/skills on its machine; not the root member; turned off, it is said so', () => {
    expect(workspaceSkills(member, [ws, member], 'home', '/h')).toEqual({ dir: '/h/work/.claude/skills' })
    expect(workspaceSkills(member, [ws, member], 'big', '/h')).toEqual({ dir: '/srv/work/.claude/skills' })
    expect(workspaceSkills(member, [ws, member], 'other', '/h')).toBeUndefined()
    expect(workspaceSkills(root, [ws, root], 'home', '/h')).toBeUndefined()
    expect(workspaceSkills(member, [{ ...ws, shared: { rootSkills: false } }, member], 'home', '/h')).toEqual({ dir: '/h/work/.claude/skills', off: true })
    expect(workspaceSkills({ ...member, workspace: undefined }, [ws, member], 'home', '/h')).toBeUndefined()
  })

  it('the workspace sheet turns them off (stored as rootSkills: false) and back on', async () => {
    const store = createPmStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-skills-')))
    await store.setEnabled(true)
    await store.addProject({ ...workspaceInput({ key: 'WS', roots: [['home', '/h/work']] }), plain: true }, async (_m, f) => ({ path: f, git: true }))
    expect((await store.updateProject('WS', { rootSkills: false })).shared?.rootSkills).toBe(false)
    expect((await store.updateProject('WS', { rootSkills: true })).shared?.rootSkills).toBeUndefined()
  })

  it('links each skill, git-ignored; the member\'s own wins; an edit shows at once; a removed one goes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-skills-'))
    const sh = (script: string, ...args: string[]) => execFileSync('sh', ['-c', script, 'sh', ...args], { encoding: 'utf8' })
    try {
      const repo = path.join(dir, 'repo'), wt = path.join(dir, 'PAY-1'), src = path.join(dir, 'work/.claude/skills')
      for (const n of ['plan', 'own', 'gone']) { fs.mkdirSync(path.join(src, n), { recursive: true }); fs.writeFileSync(path.join(src, n, 'SKILL.md'), `# ${n}`) }
      fs.mkdirSync(path.join(src, 'notes'))
      fs.mkdirSync(path.join(repo, '.claude/skills/own'), { recursive: true })
      fs.writeFileSync(path.join(repo, '.claude/skills/own/SKILL.md'), '# mine')
      sh('cd "$1" && git init -q && git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m init && git worktree add -q -b task/PAY-1 "$2"', repo, wt)
      expect(sh(SKILLS_SCRIPT, wt, src).trim().split('\n').sort()).toEqual(['linked gone', 'linked plan', 'own own'])
      expect(fs.readFileSync(path.join(wt, '.claude/skills/own/SKILL.md'), 'utf8')).toBe('# mine')
      fs.writeFileSync(path.join(src, 'plan/SKILL.md'), '# plan v2')
      expect(fs.readFileSync(path.join(wt, '.claude/skills/plan/SKILL.md'), 'utf8')).toBe('# plan v2')
      expect(sh('git -C "$1" status --porcelain', wt)).toBe('')
      fs.rmSync(path.join(src, 'gone'), { recursive: true })
      sh(SKILLS_SCRIPT, wt, src)
      expect(fs.existsSync(path.join(wt, '.claude/skills/gone'))).toBe(false)
      expect(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8').split('\n').filter(l => l === '/.claude/skills/plan')).toHaveLength(1)
      // Turned off: the links to the root go, the member's own skill stays.
      expect(sh(SKILLS_SCRIPT, wt, src, 'off')).toBe('')
      expect(fs.existsSync(path.join(wt, '.claude/skills/plan'))).toBe(false)
      expect(fs.readFileSync(path.join(wt, '.claude/skills/own/SKILL.md'), 'utf8')).toBe('# mine')
      // No skills folder at the root: nothing to do.
      expect(sh(SKILLS_SCRIPT, wt, path.join(dir, 'none'))).toBe('')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
