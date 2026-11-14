// A coordinator's proposed workflow change is reviewed in its project's sheet,
// on the Workflow tab (`review=1` opens the review at once).
export const proposalReviewPath = (key: string) => `/settings?section=projects&project=${encodeURIComponent(key)}&tab=workflow&review=1`

// A unified diff's lines, each with its class: `add`, `del` or none.
export const diffLines = (diff: string) => diff.split('\n').filter(Boolean)
  .map(l => ({ l, k: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '' }))
