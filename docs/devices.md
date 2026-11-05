# Computer, phone and iPad

[Documentation](README.md) · [Project](../README.md)

### On a computer

- **Spaces and tabs**: sidebar with every space, tabs at the top, active tab remembered per space.
  With herdr-core each terminal of a space is a tab; the header's map button lists the space's
  terminals to switch between. Rename, split and move of tabs stay in herdr-app.
- **Composer under the terminal**: an agent's terminal keeps the message field below it.
  The sidebar can be resized, or collapsed to a narrow rail (search, new agent, settings and
  state counters) with the button next to Settings; the choice is kept on the device.
- **Keyboard shortcuts** (`Mod` is ⌘ on macOS, Ctrl elsewhere; `Mod+/` or `?` lists them all,
  also in Settings › Computer):
  - `Ctrl/⌘+K` global search across agents and conversations, `Alt+↑/↓` previous / next agent
    in the list, `Alt+←/→` previous / next tab of the viewed space, `Mod+,` settings.
    The Alt steps are app navigation even with the terminal or a filled field
    focused; the virtual key bar's Alt+arrow stays a literal chord for the agent.
  - `Mod+Alt+N` new agent in a new space, `Mod+Alt+T` new tab in the current space,
    `Mod+Alt+W` close the current pane (after confirmation). They work from the terminal too.
  - In an agent: `Mod+F` searches the conversation, ``Ctrl+` `` switches between conversation
    and terminal, and `Esc` stops a working agent when the message field is empty.
  - `Esc` closes dialogs, `Enter` sends
    and `Shift+Enter` adds a new line. On a "Your turn" card, `1`–`9` pick an option (on AZERTY
    without Shift too, outside the message field), and `↑` `↓` `Enter` `Esc` go to the terminal
    while the same question is on screen.
- In the message field, `↑` on the first line recalls previous messages and slash commands;
  `↓` on the last line returns to newer entries, then restores your draft. History keeps the
  last 100 texts sent from this device per agent, without attachments or quoted references.
- **Settings** in a sidebar, with desktop-only options such as the content width
  and the interface size. Computers default to **Interface size › Large**: the
  agent surfaces and the terminal font enlarge a notch, and the reading column
  can grow to 1500 px while the terminal keeps its fitted width — choosing
  **Full width** still wins over that cap. Picking **Standard** returns to the
  usual density. The choice is kept on the device.

### On a phone

- **Compact agent header**: a 44 px bar holds Back, one two-line identity, Terminal and Options.
  The identity shows the pane name, then its square state indicator, state label and agent kind.
  Tap it (always available, even for a lone pane) for the machine/space context and everything
  that manages panes and tabs: switching (listed only when there are several; a lone pane shows its
  full name and state instead), then the current
  pane (rename, copy ID, then **Close this conversation** or **Close this terminal**: only that
  pane, from either view) and new tabs. **Close entire space…** stands apart, and only when the space holds other panes: a
  lone pane has a single close, whose confirmation says the space closes too. A tab closes from its
  overview, which says how many panes go. Every close confirmation names what stops, how many tabs
  and panes go and what stays open; if the structure changes while it is open and the close would
  now take more, the updated confirmation is shown again. Long names ellipsize; multiple panes
  show their position, never 1/1.
  Options keeps the conversation, the agent and its tools: Terminal/Conversation, search,
  notifications, browse files, keep after restart, take control, reconnect and settings.
- **Terminal function keys** start closed. The square chevron button above Send shows or hides
  one horizontally scrolling row in both Conversation and Terminal. It holds Ctrl, Esc, Tab,
  arrows, Enter, Ctrl+C, Backspace and the remaining modifiers and function keys. The phone-keyboard
  toggle comes first, and Home, End, PgUp, PgDn, Insert and Delete are available in both modes.
  In Conversation the keyboard toggle focuses the message field, and navigation uses the
  named-key API without opening a terminal connection.
  Select Shift then Tab for Shift+Tab. Closing the bar clears any armed modifier.
  The input stays on one row at rest and expands while editing. Desktop and tablet layouts
  keep their existing controls.
- **Installable app (PWA)** on iPhone and Android, with safe-area and keyboard handling.
- **Web Push notifications** when an agent finishes or needs you.
- **Quick replies**: answer permissions and questions in one tap from the agent list.
- **Terminal key bar** (Esc, Enter, arrows, Shift+Tab, Ctrl+C…) and touch scrolling.
  A finger drag or the wheel browses the history the attach delivered locally —
  the attach requests up to 1000 lines, a bound the core fills from the main
  screen only, so an alternate-screen attach gets none. Known limitation: an
  alternate-screen app's own pre-attach history is not recoverable passively —
  stitching it through `terminal.read` would scroll the application. Pressing and holding a
  still finger freezes the screen to copy from it; release and drag to select,
  then Done leaves the copy surface. Known limitation: a blank cell in a row's
  last column can be padding a wide glyph wrapped early, but is copied as a
  space — erased cells look identical in the buffer and real blanks must not
  be lost.
  On iPhone and iPad a tap on the terminal does not open the on-screen keyboard: type in the
  message field, or tap the key bar's keyboard button to type in the terminal.
  Terminal links back to this app stay in the current window on a phone; external
  links still open separately.
- **Offline reading** of the last known state and of recently opened conversations.

### On an iPad

- **Computer layout in both orientations**: in portrait the agent list folds to a narrow column
  and slides over the conversation; in landscape it stays docked. Buttons are 44 px, and the
  layout does not change when the on-screen keyboard opens.
- **Hardware keyboard**: Enter sends (Shift+Enter adds a line) once a key only a hardware
  keyboard sends (arrows, Esc, a ⌘ chord) has been typed.

The terminal key bar also has **Ctrl**, **Alt** and **Shift** toggles. Select one or
several, then tap a key or type one ASCII character on the phone keyboard. The
modifiers reset after that key; tapping a selected modifier cancels it. Pasting
or entering composed text clears the selection and keeps the text unchanged.

Split panes drawn in Herdr's layout, dragging panes and dividers, pane swaps
(`Alt+Shift+arrows`) and side-by-side focus moves are v2 only.
