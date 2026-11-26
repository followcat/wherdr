# Terminal

[Documentation](README.md) · [Project](../README.md)

- **Terminal view**: the real terminal of the hc terminal (xterm.js, WebGL or DOM renderer),
  attached through core's `terminal.attach` on a connection of its own. Every agent has it;
  `` Ctrl+` `` switches between conversation and terminal. With the WebGL renderer, the glyph
  atlas is rebuilt once after resizes settle (a divider drag gives one repaint) and once after
  the phone keyboard opens or closes: some mobile GPUs otherwise keep garbled or blank glyphs
  until then.
- **Shared with other viewers**: each viewer (phone, computer, herdr-app) has its own
  connection, so several work at once. A viewer opens at the terminal's current size and does
  not resize it until you **take control**: by typing in the terminal (or in the message field
  from the conversation view, never under the terminal), pressing a key of the key bar, or
  **Fit to this screen** in the banner ("Shown at the size of another screen."). When another
  viewer then sets its size, the banner comes back. A grid whose WebGL canvas is too large for
  a drawing buffer (for instance, a 200×120 pane on a high-density phone) is drawn by xterm's
  DOM renderer instead, so its text stays visible; **Fit to this screen** shrinks it and WebGL
  comes back. **Take control of this terminal** and
  **Reconnect** are also in the agent's **…** menu.
- **Input**: keys go to core with `terminal.keys`, text with `terminal.send` (never retried),
  Stop with `terminal.interrupt`. The history the terminal received is scrolled locally, with the
  wheel or by touch. A program that tracks the mouse in its own full screen (Claude Code's
  fullscreen view, `vim`, `less --mouse`) gets the wheel and touch scrolling as mouse wheel
  events, as in a desktop terminal, so it scrolls its own history; this never takes control of
  the terminal's size. A fast scroll is paced on the program's repaints (one burst at a time, at
  most a page kept, nothing more while it does not repaint), and in a Claude agent it allows for
  Claude Code's wheel acceleration, so a trackpad flick moves as far as the fingers and stops
  when they do. Other programs get one wheel event per row.
- **Synchronized repaints**: a program that brackets a full repaint in DEC Mode 2026
  (`CSI ? 2026 h` … `CSI ? 2026 l`, as Antigravity `agy` does when its size changes) has the whole
  frame written to xterm in one step. A clear that arrives just before the frame rides in the same
  write, so the conversation swaps to the new screen instead of scrolling through it, and the view
  stays at the tail (no history refetch). A frame left open by a broken program is released after
  one second, and a frame over 1 MiB is written at once.
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

- **Split right** and **Split down** (pane's **…** menu, absent when its folder is unknown, off
  while its machine is offline): a shell on the same machine and in the same folder, in the same
  tab, taking the right or bottom half of the pane's cell; the tab view opens on it. The layout is
  wherdr's own (a synced setting, the same on every open device within a second); herdr-app keeps
  its own and wherdr never writes it. Closing a terminal gives its room to its neighbour.
  On a computer, **Mod+Alt+S** splits the pane being viewed to the right and **Mod+Alt+Shift+S**
  splits it down, from the terminal too (changeable in Settings › Shortcuts).
- **Split with agent…** (same menu): the New agent sheet on the pane's machine and folder; the
  agent (or a terminal) it launches takes the right half of the pane's cell.
- **Resize** (computer): drag the line between two cells; each terminal fits its cell as it
  moves, and the new proportion is saved on release (arrows on a focused line move it by 5 %,
  Home and End to either bound).
  Double-click a line to go back to 50/50. Each side keeps at least 15 %. Not on a phone.

Pane swaps are v2 only for now; move of tabs stays in herdr-app.
