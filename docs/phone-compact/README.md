# Compact phone controls: PWA evidence

Follow-up to item 3 in the [#239 discussion](https://github.com/afloury/wherdr/pull/239#issuecomment-6498617087).

All content is synthetic. The fixture uses the existing omp conversation integration, a shell pane, and two tabs. It does not add an agent integration.

The screenshots are native Android 16 / Chrome 133 home-screen PWA captures at 360 and 412 CSS px. Each capture verifies `display-mode: standalone`, `WebappActivity`, no Chrome address bar, no Fullscreen API, and a closed soft keyboard. No viewport emulation or image cropping is used for these full-screen images.

Capture build: `0ef08beb6636292a0cf13d189f9f1167d32d0eac`. Product sources match PR head `83518dde224a50ee2d12a269614380eaa614cf5e`; the later commit only adjusts a browser-test fixture to an upstream-supported agent.

Download `preview.html` for a self-contained gallery. `pwa-verification.json` records the per-capture checks; `validation.json` records code validation.

- [Terminal: keys closed by default (412 CSS px)](pwa-412.png)
- [Terminal: common keys open (412 CSS px)](pwa-keys.png)
- [Conversation: keys closed by default (412 CSS px)](pwa-chat-closed.png)
- [Conversation: the same common keys open (412 CSS px)](pwa-chat-open.png)
- [Narrow phone layout (360 CSS px)](pwa-360.png)
- [Full context and pane/tab switching (360 CSS px)](pwa-picker-360.png)
- [Full context and pane/tab switching (412 CSS px)](pwa-picker-412.png)
- [Conversation: More function keys](pwa-more.png)
- [Another tab, one pane](pwa-other-tab.png)
- [Header with root text enlarged to 130%](pwa-large-text.png)
