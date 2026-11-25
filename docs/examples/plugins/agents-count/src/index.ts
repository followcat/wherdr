// Agents count: example plugin for the wherdr plugin API (docs/plugins.md).
// Mounts a live status badge into header-actions showing the agent count
// and one terminal label, updated reactively via onAgents().
interface PublicAgent {
  id: string
  name: string | null
  labels: Record<string, string>
}

interface Wherdr {
  agents: () => PublicAgent[]
  onAgents: (cb: (agents: PublicAgent[]) => unknown) => () => void
  mountHeaderAction: (render: (el: HTMLElement) => (() => void) | void) => () => void
}

const STYLE_ID = 'agents-count-style'
const CSS = `.agents-count{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 9px;border:1px solid var(--line);border-radius:0;background:var(--bg-2,transparent);color:var(--text-2,inherit);font:500 10.5px/1 var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
@media (pointer:coarse){.agents-count{min-height:44px}}`

let removeStyle: (() => void) | null = null

function firstLabelText(agents: PublicAgent[]): string | null {
  for (const agent of agents) {
    const keys = Object.keys(agent.labels).sort()
    if (keys.length === 0) continue
    const key = keys[0]!
    return `${key}=${agent.labels[key]}`
  }
  return null
}

function formatSummary(agents: PublicAgent[]): string {
  const count = `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`
  const label = firstLabelText(agents)
  return label ? `${count} · ${label}` : count
}

export default {
  activate(wherdr: Wherdr) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.append(style)
      removeStyle = () => style.remove()
    }

    wherdr.mountHeaderAction((el) => {
      const badge = document.createElement('span')
      badge.className = 'agents-count'
      badge.textContent = formatSummary(wherdr.agents())
      el.append(badge)
      return wherdr.onAgents((next) => {
        badge.textContent = formatSummary(next)
      })
    })
  },
  deactivate() {
    removeStyle?.()
    removeStyle = null
  },
}
