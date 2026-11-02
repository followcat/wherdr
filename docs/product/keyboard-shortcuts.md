# Capability: common-sense keyboard shortcuts

Status: **implemented** (2026-10-01). Code: `app/utils/shortcuts.ts` (table and matcher),
`app/composables/useShortcuts.ts` (dispatcher and actions), `app/components/ShortcutsSheet.vue`
(help sheet), `app/components/ShortcutsReference.vue` (shared with Settings › Shortcuts). Tests: `tests/shortcuts.test.ts`, `tests/cardKeys.test.ts`.
`[INFERENCE]` marks claims nobody has tested on a device yet.

> 2026-10-02: Mod+Alt+O (current agent folder in the default editor, via the existing
> /api/reveal "Open" action on the folder path) added since; action in
> `app/composables/useHerdr.ts` (`openFolderOnMachine`). First bound to E, moved to O the
> same day: Firefox and Zen own ⌘⌥E (Network Monitor) on macOS, Zen also Ctrl+Alt+E
> ("Forward workspace").

> 2026-10-06: herdr-projects keys Mod+Alt+P (Project panel) and Mod+Alt+Shift+N (New project),
> decision Q10. Removed with herdr-projects 0.2 (wherdr 2.0).

## Capability

Someone using wherdr on a computer (≥ 900 px wide, hardware keyboard) can do the everyday loop
without the mouse: find an agent, move between agents, read and search its conversation, switch
to its terminal, stop it, answer it, start a new agent or tab, and close a pane. The keys are the
ones they would guess from Slack, VS Code or ChatGPT. None of them takes a key away from the
program running in the terminal, apart from the documented exceptions in C1. This backs the [first-launch guide's](../quick-start.md)
promise that wherdr "can replace the Herdr terminal client day to day".

## Shortcuts

"Mod" is ⌘ on macOS and Ctrl elsewhere.

| Action | Keys | Where | From the terminal |
|---|---|---|---|
| Global search (existing) | Ctrl/⌘+K | Anywhere, phone included | macOS only (on Windows/Linux, xterm sends Ctrl+K to the program) |
| Previous / next agent: the card a click would open, in sidebar order; stops at the ends | Alt+↑ / Alt+↓ | Computer | Yes (caught before the terminal — fork change, see C1) |
| Previous / next space tab: the chip a click would switch to, as shown | Alt+← / Alt+→ | Computer | Yes (caught before the terminal — and before the browser's Back/Forward; fork change, see C1) |
| New agent in a new space: the "New agent" sheet, which creates the space (`workspace.create`) | Mod+Alt+N | Computer, online | Yes (caught before the terminal) |
| New tab in the current pane's space: the "Start in a new tab" sheet | Mod+Alt+T | Computer, online, a pane being viewed | Yes (caught before the terminal) |
| Close the current pane, through the same confirmation as the menu | Mod+Alt+W | Computer, online, a pane being viewed | Yes (caught before the terminal) |
| The current agent's folder in its default editor, on the agent's machine | Mod+Alt+O | Computer, a pane with a folder, on a Mac (`machineOs`) | Yes (caught before the terminal) |
| Search this conversation; if search is already open, focus and select its field | Mod+F | Agent in conversation mode | No: the browser keeps its Find there |
| Switch between conversation and terminal | Ctrl+`` ` `` on every platform, by position (`Backquote`; on macOS also `IntlBackslash`, the key left of 1 on ISO keyboards) | Agent with a conversation, or the active cell | Yes (xterm sends nothing for it) |
| Stop the working agent, same as the Stop button | Esc | Conversation mode, Stop shown, empty field, no conversation search open | No (Esc goes to the program) |
| Settings | Mod+, | Computer | Yes |
| Shortcut list | Mod+/, or `?` outside a field | Computer; also Settings › Shortcuts | Mod+/ only |
| Board: the herdr-projects tasks of every machine | `H` outside a field | Computer | No (the program gets the key) |

These existing shortcuts are unchanged and listed in the help sheet:

- Alt+Shift+arrows or Alt+Shift+H J K L swap panes (`useSpaces.swapShortcut`).
- Ctrl/⌘+Alt+arrows move focus between side-by-side cells (`viewMode.cellFocusStep`).
- In the composer: Enter, Shift+Enter, Tab and the slash menu keys. ↑ on the first logical
  line recalls previous sent texts; ↓ on the last returns to newer texts, then the saved draft
  and caret. Cards and slash suggestions keep priority. History is per device and pane, keeps
  100 texts, drops consecutive duplicates, and excludes attachments and reference lines.
  Editing a recalled text does not change stored entries.
- In the terminal: Shift+Enter and the copy keys (⌘C or Ctrl+Shift+C copy the on-screen selection,
  which releasing the mouse button also copies).
- On a "Your turn" card: ↑ ↓ Enter Esc, 1–9 and ← →.
- On an interactive menu card, the Ctrl+letters of its legend (/resume: Ctrl+A, all projects or
  the current one) press the matching button. Ctrl on every platform, as in the terminal; ⌘A
  keeps "select all" on macOS. Not taken in a field with text (select all), in the terminal
  (it sends the key itself), or for Ctrl+W/N/T (the browser keeps them).
- In the lightbox, conversation search and global search: their own keys.

Where the keys are shown:

- Tooltips: global search, new agent (rail) and settings in the sidebar; search in the agent header.
- The Board button (header and collapsed rail of the list) shows `H` in its tooltip.
- The agent menu's "Close this pane" entry shows Mod+Alt+W.
- The agent menu's "Open in editor" entry shows Mod+Alt+O (on the agent's Mac).
- The composer shows `Esc stop` while Stop is visible.
- The help sheet lists everything.

## Constraints

### C1. The terminal owns its keys

Per xterm.js:

- **Sent to the program:** Ctrl+letter, Ctrl+Space, Ctrl+3–8, Ctrl+[ \ ], and Alt+key outside
  macOS. On Linux, Ctrl+Alt+letter is sent as `ESC` + control byte and the event is stopped
  (`@xterm/xterm/src/common/input/Keyboard.ts:349-361`).
- **Bubbles up to the page:** ⌘+letter on macOS, Ctrl+Shift+letter, Ctrl+`` ` ``, Ctrl+, and Ctrl+/.
  On Windows, Ctrl+Alt counts as AltGr, so xterm lets it through (`src/browser/Terminal.ts:1085-1089`).
- **Decision:** Mod+Alt+N, T and W are caught on `window` in the capture phase, before xterm.
  - On Linux, the terminal program therefore never receives Ctrl+Alt+N, T or W.
  - This follows the precedent of Ctrl/⌘+Alt+arrows (`TabView.vue:72`).
- **Fork change — Alt+arrows are wherdr's:** Alt+↑/↓ (agents) and Alt+←/→ (space tabs) are
  also caught on `window` in the capture phase, so they work while the terminal or a field has
  focus. Two reasons, both user-visible: a focused xterm used to eat Alt+↑/↓ and made agent
  stepping look stuck, and the browser reads Alt+←/→ as Back/Forward — taking them at capture
  also shields text fields, where they would otherwise navigate away mid-draft.
  - The program running in the terminal never receives Alt+arrows (its own alt-arrow bindings,
    e.g. in some shells/tmux configs, are lost).
  - On macOS, ⌥+←/→ word jumps in text fields are taken too.
  - With no card/chip to step to the key is still swallowed — it never reaches the browser.
  - If this fork's keys are ever upstreamed, C1's "the terminal owns its keys" must be decided
    explicitly — this deviation is deliberate for the fork, not an accident.
- New shortcuts accept only the platform modifier. On macOS that leaves Ctrl+F, B, K, A and E to
  text editing. ⌘K still accepts both modifiers, as before.
- Synthetic key events (`isTrusted` false) are ignored. HeaderMenu closes its menu with a fake
  Escape, for example.

### C2. Browser and OS chords

- Chromium never lets pages see Ctrl/⌘+N, T or W (https://issues.chromium.org/41081444). That is
  why the space, tab and pane actions use Mod+Alt.
- Known conflicts with Mod+Alt, none checked on a device `[INFERENCE]`:
  - GNOME/Ubuntu opens a terminal on Ctrl+Alt+T, so the browser never sees it there.
  - Safari binds ⌥⌘W to "Close Other Tabs"; it is unverified whether a page can override that.
- How letters are matched (`keysMatch` in `shortcuts.ts`):
  - A key that types a Latin letter is matched by name.
  - Outside macOS, Ctrl+Alt is AltGr. A letter it types (Polish Ctrl+Alt+N = `ń`) is not a
    shortcut and gets typed.
  - On macOS, ⌥ changes `e.key`. ⌘⌥ letters use the letter printed on the key, from
    `navigator.keyboard.getLayoutMap()` (Chromium; ⌘⌥W is the key labelled W on an AZERTY Mac),
    otherwise its position. On Safari or Firefox with AZERTY, that position is wrong for W
    (it's the Z key). `[INFERENCE]`, not checked on a device.
  - Non-Latin layouts (Cyrillic Ctrl+F types `а`) fall back to the position.
- ⌘F and ⌘, override browser defaults. This was checked in Chromium (headless) only `[INFERENCE]`
  for Safari and Firefox.

### C3. Shortcuts work only where they make sense

- Computer layout only (`desk`), except ⌘K. Never while locked.
- Never with a window open, except the toggles: ⌘K, and the help keys while the help sheet itself
  is open. "Open" means the focus is in a dialog, menu or listbox, or the app's state says a sheet,
  the global search, the image viewer or the help sheet is open (the global search has no focus
  trap).
- Focus and windows are read once per keypress, in the capture phase, before any listener can
  change them. The image viewer closes on Escape without marking the key handled, and the composer
  blurs itself.
- Never during IME composition, including Safari's composition-ending key (`keyCode` 229). Never
  when another handler has already marked the key handled.
- With focus in a field that contains text, only Mod/Ctrl chords and the Alt+arrows fire (see
  C1: they are global navigation in this fork). Esc fires only if the field is empty. `?` never
  fires in a field.
- Actions that create or close something are disabled exactly when their buttons are: offline view,
  events closed, or a stale pane.
- Agent actions apply to `curPane`, which side by side is the active cell.

### C4. Keyboard layout

- Letters are matched by name, with the exceptions in C2. Backquote is matched by position.
- The card-digit fix: `cardKeys.ts` also accepts `Digit1`–`Digit9` without Shift when the focus is
  not in a text field. On AZERTY that row types & é " ' (.
  - In the empty composer, those characters can start a reply, so it stays Shift+digit there.
  - Before the fix, Shift+digit was the only way everywhere.
  - QWERTY's Shift+1 (`!`) is still typed as text.

### C5. Esc has many owners

Esc stops the agent only after all of the following have had their chance:

1. IME composition
2. An open window
3. A pane drag, whose listener moved to the capture phase so it runs first
4. The slash menu, which needs text in the field, so Stop isn't shown
5. Conversation search. Its field takes Esc when focused. While it's open, Composer's `escStops` is
   false, which hides the `Esc stop` hint.
6. A "Your turn" card, where the pane is blocked rather than working
7. The terminal, where Esc goes to the program

The composer blurs itself on Esc. After a stop it gets the focus back.

### C6. Shortcuts are discoverable

- Tooltips, menus and the help sheet read their key labels from the table (`shortcutKbds`).
- Nuxt UI's `UKbd` renders them per platform (⌘ ⌥ or Ctrl Alt).

### C7. One table, one matching function

- `matchShortcut(event, focus, { mac, phase, desk })` is pure and tested without a DOM.
- ⌘K moved into the table.
- Swap and cell focus stayed where they were: they need the tab layout and the active cell.
- Nuxt UI's `defineShortcuts` is not used: it cannot express the empty-field or terminal rules.

## Non-goals

- Keybindings the user can customise.
- Shortcuts that destroy something without a confirmation. Close pane always goes through
  `closePane`'s confirmation. Esc-to-stop only interrupts the agent's current turn.
- Shortcuts on the phone, or with a touch keyboard.
- Changes on the Herdr side.
- Multi-key sequences.
- A sidebar toggle (decision Q5: not now).

## Decisions (2026-10-01)

- **Q1.** Mod+F replaces the browser's Find in conversation mode: yes.
- **Q2.** Stop with Esc: yes.
- **Q3.** Alt+↑/↓ to move between agents: yes. "Next agent waiting on you" was not requested.
- **Q4.** Mod+Alt+N opens "New agent". Because that sheet creates a new space, it is also the
  "new workspace" shortcut. Mod+Alt+T (new tab) and Mod+Alt+W (close pane) follow the same pattern.
- **Q8.** Mod+Alt+O opens the agent's current folder in its default editor on the agent's Mac
  (same `/api/reveal` "Open" action as a path in the conversation: never apps or scripts, the
  folder is opened as a folder). First bound to E: Firefox and Zen take ⌘⌥E on macOS (Network
  Monitor), Zen also Ctrl+Alt+E (Forward workspace) — the shortcut never reached wherdr. O is
  free in Firefox, Zen, Chromium and Safari (⌘O "Open File" needs no Alt). The agent menu gets
  an "Open in editor" entry, the help sheet a row.

- **Q10.** herdr-projects keys, live only where the plugin is installed. Mod+Alt+P for the
  Project panel: VS Code's secondary side bar is ⌥⌘B, but Chrome on macOS binds ⌥⌘B to the
  Bookmark Manager; ⌥⌘P is unbound in Chrome, Firefox and Safari (Finder's path bar only)
  `[INFERENCE]`, not checked on a device. On a coordinator it toggles the panel (shared state
  `projectSideOpen`, the same as its collapse button); from a thread it opens the coordinator with
  the panel shown. New project is Mod+Alt+Shift+N, the Shift sibling of New agent; on Windows,
  AltGr+Shift+letter typing a non-Latin letter (Polish `Ń`) stays text. Both are caught before
  the terminal like the other Mod+Alt keys.
- **Q11.** (2026-10-12) Board key: bare `H`, like `?`, because the user asked for H.
  Mod+Alt+H is unusable on macOS: ⌘⌥H is "Hide Others", the page never sees it. Bare `H`
  does not fire while typing (any text field) or in the terminal, nor with Shift, Alt, Ctrl or ⌘
  (Alt+Shift+H stays the pane swap). Computer layout only.
- **Q5.** Sidebar toggle: not now.

## Still open

- **Q6.** Should wherdr copy the Herdr client's keybindings? The local `config.toml` has no custom
  bindings, and the repo doesn't document Herdr's default ones.
- **Q7.** Mod+1–9 to jump to the Nth agent: not now. It collides with browser tab switching.
- **Manual device pass** still to do: Safari and Firefox; the installed app on macOS, Windows
  and Linux; and a physical AZERTY keyboard.
