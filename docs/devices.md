# Computer, phone and iPad

[Documentation](README.md) · [Project](../README.md)

### On a computer

- **Split panes, live**: a tab with several panes is drawn with Herdr's real layout; every pane
  shows its conversation or terminal live. Every visible terminal fills its cell and follows
  window and divider resizing, keeping its instance and connection when focus changes.
  Click a cell to give it the keyboard. Leaving the tab restores each terminal's original size,
  unless a Herdr client has resized it meanwhile.
- **Rearrange the layout**: drag a pane onto another to move it, drag a divider to resize
  (arrow keys work on a focused divider); changes go to Herdr itself.
- **Spaces and tabs**: sidebar with every space, tabs at the top, active tab remembered per space.
  The sidebar can be resized, or collapsed to a narrow rail (search, new agent, settings and
  state counters) with the button next to Settings; the choice is kept on the device.
- **Keyboard shortcuts** (`Mod` is ⌘ on macOS, Ctrl elsewhere; `Mod+/` or `?` lists them all,
  also in Settings › Computer):
  - `Ctrl/⌘+K` global search across agents and conversations, `Alt+↑/↓` previous / next agent
    in the list, `Mod+,` settings, `H` the [Board](board.md#works-great-with-herdr-projects) (outside a
    text field and the terminal).
  - `Mod+Alt+N` new agent in a new space, `Mod+Alt+T` new tab in the current space,
    `Mod+Alt+W` close the current pane (after confirmation). They work from the terminal too.
  - In an agent: `Mod+F` searches the conversation, ``Ctrl+` `` switches between conversation
    and terminal, and `Esc` stops a working agent when the message field is empty.
  - `Alt+Shift+arrows` swaps the current pane with its neighbour, `Ctrl/⌘+Alt+arrows` moves
    focus to the neighbouring pane in a side-by-side tab, `Esc` closes dialogs, `Enter` sends
    and `Shift+Enter` adds a new line. On a "Your turn" card, `1`–`9` pick an option (on AZERTY
    without Shift too, outside the message field); on the `/resume` card, `Ctrl+A` switches
    between every project and the current one (`⌘A` still selects all on macOS).
- In the message field, `↑` on the first line recalls previous messages and slash commands;
  `↓` on the last line returns to newer entries, then restores your draft. History keeps the
  last 100 texts sent from this device per agent, without attachments or quoted references.
- **Board** for [herdr-projects](board.md#works-great-with-herdr-projects) 1.2.1 or later: every machine's
  tasks in four columns (needs you, ready to approve, working, to do), done one tap away, each
  task with its pull request, review, reply and approval.
- **Settings** in a sidebar, with desktop-only options such as the content width.

### On a phone

- **Compact agent header**: tabs open from the picker beside Back; the title and state share
  one row. Search is in Options, and the tab picker also offers tab management.
- **Terminal function keys** start closed. The small keyboard button above Send shows or hides
  them in both Conversation and Terminal. The common row is Esc, Shift, Tab, arrows and Enter;
  More holds Ctrl, Alt, paging, navigation and function keys, plus the phone-keyboard toggle.
  Select Shift then Tab for Shift+Tab; the extra row does not repeat that shortcut.
  Closing the bar clears any armed modifier. The input stays on one row at rest and expands
  while editing. Desktop and tablet layouts keep their existing controls.
- **Installable app (PWA)** on iPhone and Android, with safe-area and keyboard handling.
- **Web Push notifications** when an agent finishes or needs you (with its question), and for
  `herdr notification show` (plugins, scripts).
- **Quick replies**: answer permissions and questions in one tap from the agent list.
- **Split tabs on a small screen**: a plan of the tab's panes in Herdr's proportions, then each
  pane full screen with a mini-map and swipe to its neighbours.
- **Terminal key bar**: Esc, Shift, Tab, the four arrows and Enter stay in the main row.
  More holds Ctrl/Alt, PgUp/PgDn and function keys, plus the phone keyboard toggle.
  Touch scrolling remains available in the terminal.
  Dismissing the phone keyboard releases terminal input focus; scrolling keeps
  it closed until an intentional tap. Links back to wherdr stay in the same window.
- **Smooth touch scrolling (beta)**: drags scroll the running application directly,
  with a bounded glide after release. The live grid stays fixed while waiting for
  application frames, including at history boundaries. A new touch stops queued
  scrolling; the stopping tap does not click the application or open the keyboard.
  Full-screen applications keep their own viewport: screen snapshots are not stitched
  into a separate history document. Reading an agent's structured conversation remains
  available in the Conversation view when supported.
- **Offline reading** of the last known state and of recently opened conversations.

### On an iPad

- **Computer layout in both orientations**: in portrait the agent list folds to a narrow column
  and slides over the conversation; in landscape it stays docked. Buttons are 44 px, and the
  layout does not change when the on-screen keyboard opens.
- **Side by side by touch**: finger-sized pane buttons, grip and dividers; the active terminal
  pane has the key bar; with the keyboard open the tab fits the visible area above it.
- **Hardware keyboard**: Enter sends (Shift+Enter adds a line) once a key only a hardware
  keyboard sends (arrows, Esc, a ⌘ chord) has been typed.

The terminal key bar also has **Ctrl**, **Alt** and **Shift** toggles. Select one or
several, then tap a key or type one ASCII character on the phone keyboard. The
modifiers reset after that key; tapping a selected modifier cancels it. Pasting
or entering composed text clears the selection and keeps the text unchanged.
