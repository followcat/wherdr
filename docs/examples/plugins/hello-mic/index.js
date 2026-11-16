// docs/examples/plugins/hello-mic/src/index.ts
var SAMPLE = "This is a sample dictated text.";
var STYLE_ID = "hello-mic-style";
var SELECTOR = '[data-wherdr="composer-actions"]';
var MIC = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><rect x="9" y="3" width="6" height="11"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
var CSS = `.hello-mic{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--line);border-radius:0;background:transparent;color:var(--dim);cursor:pointer}
.hello-mic:hover,.hello-mic:focus-visible{color:inherit;border-color:currentColor}
@media (pointer:coarse){.hello-mic{width:44px;height:44px}}`;
var cleanup = null;
var index_default = {
  activate(wherdr) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
    const attach = () => {
      for (const slot of document.querySelectorAll(SELECTOR)) {
        if (slot.querySelector(".hello-mic")) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "hello-mic";
        button.setAttribute("aria-label", "Dictate (sample text)");
        button.title = "Dictate (sample text)";
        button.innerHTML = MIC;
        button.addEventListener("click", () => wherdr.draft.insert(SAMPLE));
        slot.append(button);
      }
    };
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    const off = wherdr.onNavigate(attach);
    attach();
    cleanup = () => {
      observer.disconnect();
      off();
      style.remove();
      for (const b of document.querySelectorAll(".hello-mic")) b.remove();
    };
  },
  // Called when switched off: leaves the page as it was.
  deactivate() {
    cleanup?.();
    cleanup = null;
  }
};
export {
  index_default as default
};
