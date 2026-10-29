// Agent kind of a pane (claude, codex…), pure, without Nuxt.
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const sessionAgent = (x: Json | null | undefined): string | null =>
  (x && x.agent_session && typeof x.agent_session.agent === 'string' && x.agent_session.agent) || null

// `raw`: the pane from `session.snapshot`; `entry`: its entry in `agents`
// (named agent). The process detected by Herdr wins while it runs. A
// closed agent has none: we then trust the session that the agent's integration
// reported (`agent_session.agent`), and only then the `agents`
// entry, which keeps the launch kind (a thread launched as Codex then resumed
// under Claude would stay "codex" there).
export function paneAgentKind(raw: Json, entry?: Json | null): string | null {
  return raw.agent || sessionAgent(raw) || sessionAgent(entry) || (entry && entry.agent) || null
}

// Agents whose transcript wherdr reads ("Conversation" view, previews, search).
export const TRANSCRIPT_AGENTS = ['claude', 'codex', 'omp', 'devin'] as const
export type TranscriptAgent = typeof TRANSCRIPT_AGENTS[number]
export const hasTranscript = (kind: string | null | undefined): kind is TranscriptAgent =>
  (TRANSCRIPT_AGENTS as readonly string[]).includes(kind || '')

// Kind from the transcript path (~/.claude/projects, ~/.codex/sessions,
// ~/.omp/agent/sessions).
export function transcriptKind(file: string): TranscriptAgent | null {
  if (/\/\.claude\/projects\//.test(file)) return 'claude'
  if (/\/\.codex\/(?:archived_)?sessions\//.test(file)) return 'codex'
  if (/\/\.omp\/agent\/sessions\//.test(file)) return 'omp'
  return null
}
