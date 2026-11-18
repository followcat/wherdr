# Terminal

[Documentation](README.md) · [Project](../README.md)

- **Terminal view**: the real terminal of the hc terminal (xterm.js, WebGL or DOM renderer),
  attached through core's `terminal.attach` on a connection of its own. Every agent has it;
  `` Ctrl+` `` switches between conversation and terminal.
- **Shared with other viewers**: each viewer (phone, computer, herdr-app) has its own
  connection, so several work at once. A viewer opens at the terminal's current size and does
  not resize it until you **take control**: by typing in the terminal or the message field,
  pressing a key of the key bar, or **Fit to this screen** in the banner ("Shown at the size of
  another screen."). When another viewer then sets its size, the banner comes back. **Take
  control of this terminal** and **Reconnect** are also in the agent's **…** menu.
- **Input**: keys go to core with `terminal.keys`, text with `terminal.send` (never retried),
  Stop with `terminal.interrupt`. The history the terminal received is scrolled locally, with the
  wheel or by touch.
- **History on demand**: an open asks core for a few screens of history (200 lines), and the
  older output comes when you scroll back to the top of what the terminal holds — up to 5000
  lines, fetched once on the same connection, with a short *Loading earlier output* strip while
  it comes and the view kept on the line you were reading. An app on its alternate screen keeps
  its own history, so nothing is fetched there.
- **Kept while you are away**: leaving the terminal (Conversation, another agent, the home
  screen) parks it with its connection instead of closing it, so coming back shows the same
  screen at once — no download, no repaint. Two recently viewed terminals are kept for two
  minutes, then closed; a hidden page closes them at once, and a connection that ended while
  parked (another viewer took control, a wake-up) reopens the terminal fresh.
- **Copy and links**: on a computer, drag over the text on screen to select it: releasing the
  button copies it, as do `⌘C` / `Ctrl+Shift+C`. Links (OSC 8 hyperlinks and plain `http(s)://`
  URLs, even wrapped over several rows) open in a new tab with `⌘`+click / `Ctrl`+click, or a tap
  on a phone; only http and https open. A long line wrapped by the width is copied in one piece.
- **Keep after restart** (agent's **…** menu): a kept terminal comes back as a shell when core
  restarts or loses it.
- **Close** ends the terminal's program (`terminal.kill`) after confirmation.

Split layouts, dragging panes and dividers, and pane swaps are v2 only: with herdr-core, every
terminal of a space is a tab, and rename, split and move of tabs stay in herdr-app.
