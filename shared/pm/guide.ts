// The "Getting started" guide of project management: four steps, each done
// or not from what the server reports. Pure, so the board, the settings and
// the tests read the same answer.
import type { PmOverview } from './project'

export type GuideStepId = 'enable' | 'template' | 'projects' | 'coordinator'
export interface GuideStep { id: GuideStepId, done: boolean }

// Only what the guide needs from a coordinator: its project and whether a
// conversation was started (it then has a terminal).
type Coord = { project: string, terminal?: string }

export function guideSteps(o: Pick<PmOverview, 'enabled' | 'projects' | 'templates'> | null, coords: Coord[] = []): GuideStep[] {
  const enabled = !!o?.enabled
  const projects = o?.projects ?? []
  const withTemplate = new Set(projects.filter(p => p.from).map(p => p.key))
  return [
    { id: 'enable', done: enabled },
    // A saved template, or a project whose workflow was copied from one (an example is not saved).
    { id: 'template', done: enabled && ((o?.templates.length ?? 0) > 0 || withTemplate.size > 0) },
    // Every project has one: imported projects come without.
    { id: 'projects', done: enabled && projects.length > 0 && withTemplate.size === projects.length },
    { id: 'coordinator', done: enabled && coords.some(c => !!c.terminal && withTemplate.has(c.project)) },
  ]
}

// Nothing set up yet: off, or no project follows a template.
export const guideNeeded = (o: Pick<PmOverview, 'enabled' | 'projects'> | null) =>
  !!o && (!o.enabled || !o.projects.some(p => p.from))

// The project whose coordinator the last step starts: the first with a template.
export const guideProject = (o: Pick<PmOverview, 'projects'> | null) => o?.projects.find(p => p.from)?.key
