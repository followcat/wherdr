// A failed step action's badge ("Merged: merge: 2 check(s) failed", see
// shared/pm/steps.ts) said for people: what went wrong and what happens next.
// Unknown reasons keep their raw text.
const KNOWN: [RegExp, (m: RegExpMatchArray) => [string, string]][] = [
  [/the PR head is not the task's commit/, () => [
    'The PR on GitHub is not at the task\'s latest commit: its branch moved (often the agent fixing a conflict or a check). Press again once the PR has the new commits.',
    'La PR sur GitHub n’est pas au dernier commit de la tâche : sa branche a bougé (souvent l’agent qui corrige un conflit ou une vérification). Rappuie quand la PR a les nouveaux commits.',
  ]],
  [/(\d+) check\(s\) failed/, m => [
    `${m[1]} check(s) failed on the PR: the agent is asked to fix them. Press again once they are green.`,
    `${m[1]} vérification(s) en échec sur la PR : l’agent est chargé de les corriger. Rappuie quand elles sont vertes.`,
  ]],
  [/checks still running|waiting for check/, () => [
    'The PR\'s checks have not finished. Press again once they are green.',
    'Les vérifications de la PR ne sont pas finies. Rappuie quand elles sont vertes.',
  ]],
  [/conflict|not mergeable|cannot be cleanly created/i, () => [
    'The PR conflicts with its target branch: the agent is asked to bring it up to date. Press again once it is.',
    'La PR est en conflit avec sa branche cible : l’agent est chargé de la mettre à jour. Rappuie ensuite.',
  ]],
  [/base branch policy prohibits the merge|review is required|required status check/i, () => [
    'GitHub\'s rules for the target branch refuse the merge for now (a review or a check they require). Press again once they allow it.',
    'Les règles GitHub de la branche cible refusent la fusion pour l’instant (une relecture ou une vérification exigée). Rappuie quand elles l’autorisent.',
  ]],
  [/no open PR for this task/, () => [
    'This task has no open PR to merge: the PR step has to open one first.',
    'Cette tâche n’a pas de PR ouverte à fusionner : l’étape de la PR doit d’abord en ouvrir une.',
  ]],
]

export function stepRefusalText(badge: string): string {
  for (const [re, say] of KNOWN) {
    const m = badge.match(re)
    if (m) return tl(...say(m))
  }
  return badge
}
