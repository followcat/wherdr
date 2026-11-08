// The choices after N send-backs (shared/pm/verdict.ts): the button, and what it does in one line.
import type { Choice } from '#shared/pm/verdict'

export const CHOICE_LABEL: Record<Choice, [string, string]> = {
  pass: ['Pass', 'Valider'], round: ['One more round', 'Un tour de plus'], worker: ['The agent is right', 'L’agent a raison'], reviewer: ['The reviewer is right', 'Le relecteur a raison'],
  split: ['Split the rest', 'Séparer le reste'], swap: ['Change agent', 'Changer d’agent'], abandon: ['Abandon', 'Abandonner'],
}

export const CHOICE_MEANING: Record<Choice, string> = {
  pass: 'The review passes: on to the next step.',
  round: 'The agent fixes the findings in question once more.',
  worker: 'The contested findings are dropped: on to the next step.',
  reviewer: 'The agent fixes the contested findings.',
  split: 'On to the next step; what is left becomes a new task.',
  swap: 'A new agent takes the work over and fixes the findings.',
  abandon: 'The task ends here, nothing merged.',
}
