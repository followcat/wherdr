// A coordinator's reply to a wake is a message to the user. Only a routine
// one-liner may fold under its wake row ("Nothing new, …"): a single short
// line, with no link and no question. A reply with a `wherdr` block (choices,
// task, status, ui action), a link or more than one line always shows in full.
const SHORT = 160
const LINK = /https?:\/\/|\]\(|#\/\w/
export function foldableReply(text: string): boolean {
  const t = text.trim()
  return !!t && t.length <= SHORT && !t.includes('\n') && !t.includes('```') && !LINK.test(t) && !/\?\s*$/.test(t)
}
