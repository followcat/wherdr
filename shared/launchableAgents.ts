// Values of `herdr agent start --kind` (Herdr 0.9.1). Keep this list
// separate from the installed agents, which vary per machine.
export const HERDR_AGENT_KINDS = [
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline',
  'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid',
  'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'letta', 'maki', 'muse',
] as const

export function availableAgentKinds(found: Iterable<string>, allowed: readonly string[] = HERDR_AGENT_KINDS): string[] {
  const installed = new Set(found)
  return HERDR_AGENT_KINDS.filter(k => allowed.includes(k) && installed.has(k))
}

// The command an agent kind runs (when it is not the kind's own name):
// cursor-agent is Cursor's agent CLI; `cursor` alone is its editor's wrapper.
export const AGENT_BINARY: Record<string, string> = { cursor: 'cursor-agent' }
const BINARY_KIND = Object.fromEntries(Object.entries(AGENT_BINARY).map(([k, b]) => [b, k]))
export const agentBinary = (kind: string) => AGENT_BINARY[kind] ?? kind
export const binaryKind = (binary: string) => BINARY_KIND[binary] ?? binary
