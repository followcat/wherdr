// Plain words for a template's steps: a label for each engine action, a hint
// for each holder and end, and one sentence saying what happens at a step.
// The one place for these texts, shared by the template editor and the board.
// Pure: the caller passes its own tl(en, fr) for the language.
import { actionField, type End, type Holder, type Step, type StepAction } from './workflow'
import { shotMode } from './shots'
import { DEFAULT_ROUNDS } from './steps'

export type Tl = (en: string, fr: string) => string
const english: Tl = en => en

export { actionField }

// No branch named: the project's working branch, resolved when a task plans its steps.
const working = (tl: Tl) => tl('the working branch', 'la branche de travail')

export function actionLabel(a: Pick<StepAction, 'kind' | 'target' | 'base'>, tl: Tl = english): string {
  const b = a.target || a.base || working(tl)
  switch (a.kind) {
    case 'git.land': return tl(`Merge into ${b} (no PR)`, `Fusionner dans ${b} (sans PR)`)
    case 'git.push': return tl('Push the branch', 'Pousser la branche')
    case 'github.pr': return tl(`Open a GitHub PR to ${b}`, `Ouvrir une PR GitHub vers ${b}`)
    case 'github.merge': return tl('Merge the GitHub PR', 'Fusionner la PR GitHub')
    case 'git.verify-merged': return tl(`Check it is merged into ${b}`, `Vérifier que c’est fusionné dans ${b}`)
  }
}

export function holderHint(h: Holder, tl: Tl = english): string {
  switch (h) {
    case 'worker': return tl('does the task', 'fait la tâche')
    case 'reviewer': return tl('checks the work', 'vérifie le travail')
    case 'coordinator': return tl('the project’s coordinator', 'le coordinateur du projet')
    case 'none': return tl('the engine or you', 'le moteur ou toi')
  }
}

export function endHint(e: End | '', tl: Tl = english): string {
  switch (e) {
    case 'report': return tl('the agent says it is done', 'l’agent dit qu’il a fini')
    case 'verdict': return tl('pass or send back', 'valide ou renvoie')
    case 'user': return tl('waits for your button', 'attend ton bouton')
    case 'action': return tl('the engine runs an action', 'le moteur lance une action')
    case '': return tl('start or finish', 'départ ou fin')
  }
}

const who = (h: Holder | undefined, tl: Tl) =>
  h === 'reviewer' ? tl('The reviewer', 'Le relecteur') : h === 'coordinator' ? tl('The coordinator', 'Le coordinateur') : tl('The worker', 'L’agent')

function proofs(s: Step, tl: Tl): string {
  const list = (s.evidence ?? []).map((e) => {
    switch (e) {
      case 'link': return tl('a link', 'un lien')
      case 'commit': return tl('the commit', 'le commit')
      case 'report': return tl('a report', 'un rapport')
      case 'proposed-tasks': return tl('the proposed tasks', 'les tâches proposées')
      case 'screenshots': return shotMode(s) === 'before-after' ? tl('screenshots before and after', 'des captures avant et après') : tl('screenshots', 'des captures')
    }
  })
  return list.length ? tl(`; it must attach ${list.join(', ')}`, ` ; il doit joindre ${list.join(', ')}`) : ''
}

// What the engine does for an action, without the leading subject.
function engineDoes(a: StepAction, guarded: boolean, tl: Tl): string {
  const named = a.target || a.base, b = named || working(tl)
  const yours = guarded ? tl(` ${named || 'The working branch'} is protected: it waits for you to merge.`, ` ${named || 'La branche de travail'} est protégée : la fusion t’attend.`) : ''
  switch (a.kind) {
    case 'git.land': return tl(`The engine merges the task’s branch into ${b} and pushes it, without a PR. A conflict sends it back to the agent.`,
      `Le moteur fusionne la branche de la tâche dans ${b} et la pousse, sans PR. Un conflit la renvoie à l’agent.`) + yours
    case 'git.push': return tl('The engine pushes the task’s branch. Uncommitted changes send it back to the agent.',
      'Le moteur pousse la branche de la tâche. Des changements non commités la renvoient à l’agent.')
    case 'github.pr': return tl(`The engine pushes the branch and opens a GitHub PR to ${b}.`, `Le moteur pousse la branche et ouvre une PR GitHub vers ${b}.`)
    case 'github.merge': {
      const how = a.method ? tl(` (${a.method})`, ` (${a.method})`) : ''
      const checks = a.checks?.length ? tl(` once ${a.checks.join(', ')} ${a.checks.length > 1 ? 'are' : 'is'} green`, ` une fois ${a.checks.join(', ')} au vert`) : ''
      return tl(`The engine merges the GitHub PR${how}${checks}.`, `Le moteur fusionne la PR GitHub${how}${checks}.`)
        + (guarded ? tl(' Its base is protected: it waits for you to merge.', ' Sa base est protégée : la fusion t’attend.') : '')
    }
    case 'git.verify-merged': return tl(`The engine checks the branch is merged into ${b}; if not, it waits for you.`,
      `Le moteur vérifie que la branche est fusionnée dans ${b} ; sinon, il t’attend.`)
  }
}

const after = (s: Step, tl: Tl) => [
  s.recheck ? tl(` It is asked to check again every ${s.recheck}.`, ` On lui redemande de vérifier toutes les ${s.recheck}.`) : '',
  s.timeout ? tl(` After ${s.timeout}, it comes to you.`, ` Après ${s.timeout}, elle te revient.`) : '',
].join('')

// One sentence (or two) saying what happens at a step. `at`: its place in the
// task type, for a step with no end; `guarded`: a merge only the user may do.
export function describeStep(s: Step & { guarded?: boolean }, tl: Tl = english, at: { first?: boolean, last?: boolean } = {}): string {
  const guarded = !!s.guarded
  switch (s.ends) {
    case 'report': {
      const does = s.holder === 'worker' ? tl('does the task', 'fait la tâche') : tl('follows its instructions', 'suit sa consigne')
      return tl(`${who(s.holder, tl)} ${does} and says when it is done`, `${who(s.holder, tl)} ${does} et dit quand c’est fini`) + proofs(s, tl) + '.' + after(s, tl)
    }
    case 'verdict': {
      const n = s.rounds ?? DEFAULT_ROUNDS
      return tl(`${who(s.holder, tl)} checks the work: a major finding sends it back to ${s.sendBack || '…'}, up to ${n} times, then you decide.`,
        `${who(s.holder, tl)} vérifie le travail : un problème majeur le renvoie à ${s.sendBack || '…'}, jusqu’à ${n} fois, puis tu décides.`) + after(s, tl)
    }
    case 'user': {
      const button = s.userLabel ? tl(` (button “${s.userLabel}”)`, ` (bouton « ${s.userLabel} »)`) : ''
      const then = s.action ? ' ' + tl('Then:', 'Ensuite :') + ' ' + engineDoes(s.action, false, tl).replace(/^./, c => c.toLowerCase()) : ''
      return tl(`Waits here until you act${button}.`, `Attend ici que tu agisses${button}.`) + then + after(s, tl)
    }
    case 'action':
      return s.action ? engineDoes(s.action, guarded, tl) + after(s, tl) : tl('The engine runs an action: choose which.', 'Le moteur lance une action : choisis laquelle.')
    default:
      if (at.first) return tl('The task waits here until it starts.', 'La tâche attend ici son départ.')
      if (at.last) return tl('The task is done.', 'La tâche est finie.')
      return tl('Nothing happens here: the task goes straight on.', 'Rien ne se passe ici : la tâche continue aussitôt.')
  }
}
