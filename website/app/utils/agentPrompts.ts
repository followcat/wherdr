// The install prompts of the "Paste this into your coding agent" card, taken
// at build time from docs/install-with-an-agent.md (their only source), with
// the repository's address in place of its REPO placeholder.
// The doc is in the deploy's sparse checkout (.github/workflows/site.yml).
import doc from '../../../docs/install-with-an-agent.md?raw'
import { REPO } from './site'

export function promptOf(markdown: string, heading: string): string {
  const text = markdown.split(`\n## ${heading}\n`)[1]?.match(/```text\n([\s\S]*?)\n```/)?.[1]
  if (!text) throw new Error(`docs/install-with-an-agent.md: no prompt under "## ${heading}"`)
  return text.replace(/\bREPO\b/g, REPO)
}

export const AGENT_PROMPTS = [
  { id: 'new', label: 'New install', text: promptOf(doc, 'New install of v3') },
  { id: 'beside', label: 'Beside wherdr 2', text: promptOf(doc, 'v3 beside an existing v2, with import') },
] as const
