// The limits of a `wherdr` block's `choices` and `questions` lines: the chat's
// parser enforces them (parseWherdrBlock in app/utils/markdown.ts) and the
// agents' instructions state them (shared/pm/uiGuide.ts).
export const CHOICES_MIN = 1
export const CHOICES_MAX = 4
export const CHOICE_MAX_CHARS = 80
export const QUESTION_CHOICES_MIN = 2
export const QUESTIONS_MAX = 8
export const QUESTION_MAX_CHARS = 200
