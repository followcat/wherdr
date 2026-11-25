# Design rules

This is the single design reference for wherdr interface changes. Follow the
existing app rather than introducing a second visual system. Source examples below
are in [main.css](../app/assets/css/main.css), unless linked separately.

## Structure and typography

Keep the brutalist herdr.dev style: square corners and thin, 1 px rules separating
surfaces. Use the existing font tokens: Archivo for display headings (`--display`),
Inter for body text (`--sans`), and JetBrains Mono for technical text and labels
(`--mono`). Labels are uppercase mono, with the existing letter spacing; do not
uppercase body copy. Examples: `.hw-sheet-title`, `.menu-group`, `.task-chip` and
the `--font-display`, `--font-sans`, `--font-mono` definitions.

## Theme colors

Use theme variables only in interface styling: `--text`, `--text-2`, `--muted`,
`--dim`, `--line`, `--line-soft`, `--accent`, `--on-accent`, `--bg`, `--surface`
and the semantic state tokens. Do not add hardcoded hex, RGB or named colors to
components. Palette values belong in the theme definitions in `main.css` and
[themes.ts](../app/utils/themes.ts); themes can override the state colors too.
Project key badges ([ProjectBadge.vue](../app/components/ProjectBadge.vue)) take
one of 12 fixed `--project-<color>` tokens (`PROJECT_COLORS` in
[projectKey.ts](../shared/pm/projectKey.ts)), mid-tones readable on dark and light; a
workspace member's badge has a dashed border.
Examples: `.menu button:active` uses `--surface-2`, `.task-chip` uses `--line`,
and `.card-state.working` uses `--working`.

## Agent and pane state

Use the small square indicator, never a circle, rounded dot or circular status
icon. Reuse `.card-state i` or `.pill i`, as in
[AgentCard.vue](../app/components/AgentCard.vue) and
[AgentView.vue](../app/components/AgentView.vue). Their base size is **7 × 7 px**.
Keep the label alongside the indicator so color is not the only signal.

| State | Theme token | Shape and behavior | Source example |
| --- | --- | --- | --- |
| Ready (`idle` in CSS) | `--idle` (green by default) | Hollow square, inset outline | `.card-state.idle i`, `.pill.idle i` |
| Working | `--working` (purple by default) | Filled square, 1.3 s pulse | `.card-state.working i`, `.pill.working i` |
| Blocked | `--blocked` (orange by default) | Filled square, 0.9 s pulse | `.card-state.blocked i`, `.pill.blocked i` |
| Done | `--done` (green by default) | Filled square | `.card-state.done`, `.pill.done` |
| Inactive | `--muted` | Hollow square | `.pill.inactive i` |
| Unknown / shell (card dot only: on the home, no status counts as Ready) | `--dim` | Filled square | `.card-state.unknown`, `.card-state.shell`, `.pill.unknown`, `.pill.shell` |

Preserve the existing deliberate size variations rather than copying them into a
new status system: `.card-state.blocked i` is 8 px; compact home lead indicators
are 9 px (10 px when blocked) under `.card.compact.home-lead`. The shape remains
square. The color names above describe the default Titanium palette, not fixed
colors to impose on other themes.

## Loading states

Never show a default as if it were the value: while a section's data loads, an
off switch or an empty list would read as real. Show skeletons instead, built from Nuxt UI's `USkeleton`
blocks, with [SettingsSkeleton.vue](../app/components/SettingsSkeleton.vue): muted square
blocks at the size of what comes (rows of a settings card, a switch), a gentle
pulse that stops under `prefers-reduced-motion`, and the buttons that need the
data disabled. A failed load shows its error and *Try again*, never the
defaults. Example: [ProjectsSettings.vue](../app/components/ProjectsSettings.vue).
A view built from several reads waits for all of them before its first paint
(skeletons until then, never the sections that happen to be in), then keeps its
last data on later refreshes: [HomeSkeleton.vue](../app/components/HomeSkeleton.vue).
The conversation's ([ChatSkeleton.vue](../app/components/ChatSkeleton.vue)) stays
static. Never draw a loading block by hand: use `USkeleton`, which `app.config.ts`
maps to the square, muted, pulsing `.skel` class of `main.css` (never Nuxt UI's
rounded default).

## Icons and buttons

Use Lucide icons (`i-lucide-*`) for interface actions. Reuse the icon already used
for the same action; search existing components before choosing one.

| Action | Icon | Existing example |
| --- | --- | --- |
| Send | `i-lucide-arrow-up` | `UChatPromptSubmit` in [Composer.vue](../app/components/Composer.vue) (Nuxt UI submit icon) |
| Back | `i-lucide-chevron-left` | [AgentView.vue](../app/components/AgentView.vue), `.back` |
| More / options | `i-lucide-ellipsis` | [SpaceMenu.vue](../app/components/SpaceMenu.vue), `.space-menu` |

Agent branding and the existing `i-herdr-stop` glyph in `Composer.vue` are not
alternative action icon libraries to extend.

Buttons have square corners: no circular or pill-shaped buttons. Use existing
Nuxt UI controls with the app's classes, such as `.mono-btn`, `.icon-btn` and
`.task-sheet-actions > button`, rather than introducing a new button style.

Switches (`USwitch`) are green when on, in every theme: `app/app.config.ts` makes
`success` their default color, so give them no `color`. Size `xl` in Settings
rows, `lg` in windows.

A choice among **2 to 4 options** in Settings is a segmented control, never radio
rows or a select: [SettingsChoice.vue](../app/components/SettingsChoice.vue), a
single-choice `UToggleGroup` drawn by `.hw-seg` as a compact segmented button, not
tabs: as wide as its options (never full width), always one row, about a normal
button's height, square cells under 1 px rules, uppercase mono labels with a small
Lucide icon left of the label where one helps. The chosen option is filled (accent
background, `--on-accent` text), with no bar on top. On a narrow phone the cells
and letters tighten and a long label wraps inside its cell, never into a grid.
The chosen option's description shows under it, and tapping it again keeps
it. Examples: Appearance › Theme (Dark, Light, System), the Typewriter, a Pace
account's mode, a notification level, *Files shown from conversations*, and in a
project's sheet its placement, repository visibility and workspace instructions.
Five options or more stay a `USelect`: a list that can grow (Settings › Projects'
tab filter) passes through `SettingsChoice` anyway, which turns into a select
past 4. On/off stays a switch.

Every touch target must be at least **44 × 44 px**. The drawn control can be
smaller if its actual hit area reaches that minimum. Example: `.prompt-send` is
32 px with `::after { inset: -8px }`, producing a 48 px hit area. Reserve space
for the expanded target: it must not overlap a neighbor's hit area. Coarse-pointer
`.icon-btn` controls are 44 × 44 px; `.hw-sheet-handle` draws a small bar within
a 44 px-high button. Check hit geometry, not just the visible icon.

## Phone headers and sheets

Phone header bars must be **44 px high**, excluding safe-area insets. Build around
the existing 44 px `.icon-btn` controls and `.agent-top` structure; do not add
padding that unnecessarily increases the bar height. These selectors are the
integration points, not evidence that every current header already meets this rule.

Reuse [AppSheet.vue](../app/components/AppSheet.vue) for drawers and sheets:
it is Nuxt UI's `UDrawer` on the phone and `UModal` on a computer (same props and
slots, `PHONE_QUERY` decides), restyled by `.hw-sheet` / `.hw-scrim` (square, no
library rounding). Outside tap and downward swipe close a phone sheet (the
drawer's own drag, from the handle, the header or the content scrolled to its
top); the handle also supports tap, and Escape closes either. On open, focus goes
to the sheet itself (no outline), not to its handle or first button; Tab reaches
the buttons, which keep their keyboard focus ring; the focus stays inside while
it is open and returns where it was on close. A sheet with a title shows
AppSheet's square close cross (`.hw-sheet-close`, `i-lucide-x`, ghost) at the
header's right, beside the title's first line, on the phone and on a computer;
do not draw another. A sheet's own header controls (a project's ⋯ menu) go in
AppSheet's `actions` slot, just before the cross. The handle is AppSheet's own `.hw-sheet-handle` (36 × 4 px bar in a
44 px target), not the drawer's. Full-screen
`screen` views disable sheet dragging, so retain an explicit navigation action
when using that mode.

Sheets and settings pages never scroll sideways, and have **one vertical
scroll**, the sheet's body: a tab's content takes its natural height, with no
inner scroll box. That scroll ends at the sheet's bottom edge: the gap under
the last element and the phone's home bar room are padding inside it
(`--sheet-end` on `.hw-sheet`, on the footer when the sheet has one), never a
band under the scrolled content; a sheet's own content adds no bottom padding.
A bar pinned at the bottom of the scroll (`position: sticky; bottom: 0`, a
task's To do buttons on the phone, the folder picker's buttons) is the body's
last element and carries that padding itself; the body then has none, so the
bar sits on the sheet's edge and nothing scrolls under it.
Home's list follows the same rule: its scroll runs to the screen's bottom edge,
under the floating **+ New** (`.fab-wrap`, `position: absolute`), and its bottom
padding (the button's height plus the safe area) lets the last card scroll clear
of the button; no footer band is reserved for it.
What could overflow shrinks, wraps or is ellipsized: grid
and flex children get `min-width: 0` (`minmax(0, 1fr)` tracks), long names and
paths wrap with `overflow-wrap: anywhere`, fields are `w-full` or
`min(100%, …)`. The one exception is a row meant to be swiped (the phone's row
of screenshots in a task's To do). Scrollbars are the app's, set once in
[main.css](../app/assets/css/main.css): thin, in the theme's line color, never
the browser default; a strip of chips may hide its bar instead. On a computer
the project and task sheets are 920 px wide. The check is
[core-sheets.spec.ts](../tests/e2e/core-sheets.spec.ts).

Reuse [MenuSheet.vue](../app/components/MenuSheet.vue), `.menu`, `.menu-group`,
`.menu-sep` and `.menu-note` for action lists and grouped menus. Use
[SpaceMenu.vue](../app/components/SpaceMenu.vue) as the example of a menu that
adapts between phone sheets and desktop dropdowns. Avoid parallel sheet or menu
implementations.

## Text and layout checks

Follow [Contributing: Conventions](../CONTRIBUTING.md#conventions) for English
only interface text and `t()` / `tl()` usage; French translations are optional. Do not duplicate
those translation rules here. Examples: the translated Send label in
[Composer.vue](../app/components/Composer.vue) and Back in
[AgentView.vue](../app/components/AgentView.vue).

For every interface change, inspect the layout on an iPhone-sized phone and a
computer (iPhone 13 and 1440 × 900 are the repository's screenshot sizes). Check
text wrapping, header height, touch targets and their neighbors, menu and sheet
dismissal, scrolling, keyboard and safe areas. Use the existing responsive
`.agent-top` and `.hw-sheet.screen` styles as integration examples. Follow the
[device guide](devices.md) and the [iOS convention](../CONTRIBUTING.md#conventions);
use the isolated demo screenshot workflow in
[Contributing](../CONTRIBUTING.md#the-browser-demo) for visual evidence.

**Nothing scrolls sideways: a sheet's or a page's content never exceeds its
width.** Use no negative horizontal margin (`margin-left`, `margin-right`, a
shorthand's sides, Tailwind `-mx-*`): to align an icon or a swatch inside a
larger touch target, place it inside with padding or `justify-items: start`.
One stays only when its parent clips (`overflow: hidden`) or has at least that
much padding, and its line then says why: `/* overflow-safe: <why> */`.
[tests/negativeMargins.test.ts](../tests/negativeMargins.test.ts) fails on any
other in `app/`.
