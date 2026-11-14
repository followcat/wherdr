// Logo of each agent kind (AgentAvatar, header of a reply in the chat).
// Brand logos live in app/assets/icons (collection `herdr`), the rest are lucide.
export const AGENT_ICON: Record<string, string> = {
  claude: 'i-herdr-claude-code',
  codex: 'i-herdr-codex',
  omp: 'i-herdr-omp',
  gemini: 'i-lucide-sparkles',
  opencode: 'i-lucide-code-xml',
  kimi: 'i-lucide-moon-star',
  agy: 'i-lucide-orbit',
}

export const agentIcon = (agent: string | null | undefined): string | null =>
  (agent && Object.hasOwn(AGENT_ICON, agent) ? AGENT_ICON[agent]! : null)
