// docs/examples/plugins/hello-header/src/index.ts
var TEMPLATE = "Summarize the current state and next steps.";
var STYLE_ID = "hello-header-style";
var ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/></svg>';
var CSS = `.hello-header{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 9px;border:1px solid var(--line);border-radius:0;background:var(--bg-2,transparent);color:var(--text-2,inherit);font:500 10.5px/1 var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;cursor:pointer}
.hello-header:hover,.hello-header:focus-visible{color:var(--text,inherit);border-color:var(--accent,currentColor);outline:none}
.hello-header:active{background:var(--surface-2,transparent)}
@media (pointer:coarse){.hello-header{min-height:44px;min-width:44px}}`;
var removeStyle = null;
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
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hello-header";
      button.setAttribute("aria-label", "Insert prompt template");
      button.title = "Insert prompt template";
      button.innerHTML = `${ICON}<span>Prompt</span>`;
      button.addEventListener("click", () => {
        if (wherdr.draft.get() === null) return;
        wherdr.draft.insert(TEMPLATE);
        wherdr.draft.focus();
      });
      el.append(button);
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
