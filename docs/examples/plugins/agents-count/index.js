// docs/examples/plugins/agents-count/src/index.ts
var STYLE_ID = "agents-count-style";
var CSS = `.agents-count{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 9px;border:1px solid var(--line);border-radius:0;background:var(--bg-2,transparent);color:var(--text-2,inherit);font:500 10.5px/1 var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
@media (pointer:coarse){.agents-count{min-height:44px}}`;
var removeStyle = null;
function firstLabelText(agents) {
  for (const agent of agents) {
    const keys = Object.keys(agent.labels).sort();
    if (keys.length === 0) continue;
    const key = keys[0];
    return `${key}=${agent.labels[key]}`;
  }
  return null;
}
function formatSummary(agents) {
  const count = `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;
  const label = firstLabelText(agents);
  return label ? `${count} \xB7 ${label}` : count;
}
var index_default = {
  activate(wherdr) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);
      removeStyle = () => style.remove();
    }
    wherdr.mountHeaderAction((el) => {
      const badge = document.createElement("span");
      badge.className = "agents-count";
      badge.textContent = formatSummary(wherdr.agents());
      el.append(badge);
      return wherdr.onAgents((next) => {
        badge.textContent = formatSummary(next);
      });
    });
  },
  deactivate() {
    removeStyle?.();
    removeStyle = null;
  }
};
export {
  index_default as default
};
