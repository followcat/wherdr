## New

**Protection for users who upgraded to Shepherdr 2.** wherdr recognizes Shepherdr 2.x and displays **Shepherdr 2 detected: wherdr’s Board does not support it**, instead of saying the plugin is too old. It refuses to install or update herdr-projects over Shepherdr 2. Agents, terminal, files and machines remain available; wherdr does not start Shepherdr or migrate its data automatically.

To return manually to the supported herdr-projects 1.2.21, first finish or stop ongoing work, stop Shepherdr using its own controls, and back up both data stores, worktrees and Herdr configuration, including Shepherdr's takeover backup. On the affected machine, run:

```sh
herdr plugin uninstall herdr-projects && herdr plugin install eliasstravik/herdr-projects --ref v1.2.21 --yes
```

Follow the [Shepherdr 2 return checklist](https://github.com/afloury/wherdr/blob/v2.4.0/docs/herdr-projects-1x.md#shepherdr-2) to check and restore the required configuration entries before reloading Herdr and refreshing wherdr. Reinstalling does not import Shepherdr tasks, undo its configuration or network changes, or restore ongoing agents. Keep the 2.x store and backups, and avoid an unpinned plugin update that could install Shepherdr 2 again.

Global search (⌘K) now finds Board tasks by key, title or description and opens the selected task on the Board. Terminal Ctrl, Alt and Shift can be armed for the next key, and an optional individual-agent list shows standalone agents as separate rows. Thanks to [@followcat](https://github.com/followcat) for the modifier controls and individual-agent list.

## Improved

Swipe between machine and group tabs on Home. Task panels combine conversation and terminal in one Agent tab, queued Claude messages can be sent immediately, and chat commands run in a verified wherdr-managed split terminal.

A device-local beta setting enables smooth terminal touch scrolling, while the existing behavior remains the default. Transcript notices can be dismissed, and update banners show how many newer stable releases are available. Thanks to [@followcat](https://github.com/followcat) for these contributions, including the original scrolling work.

Claude sessions billed through an API key or Console credits show API usage with no quota on Home and in Settings. Update the Claude status line on those machines to enable detection. A shared keyboard shortcut reference and refreshed narrated tutorials, including “wherdr in one minute”, help you find your way around.

## Fixed

Connections recover after the device wakes without competing socket probes. Starting a command just after creating a split or tab no longer falsely reports that it did not start while the new pane is being discovered.

The WebGL terminal stays sharp and correctly sized on high-density screens, and long agent state lines fit phone headers. Wrapped task titles keep their height, and Autopilot messages show their copy button only on hover.

Codex self-updates are detected with Ubuntu shell prompts, status reset information remains visible alongside footer warnings, and passive reads leave shell history alone. A folder used as a transcript path returns “no conversation”. omp 18.14 tool approval cards are recognized again, including grants and expanded details, while older dialogs remain supported.

Settings navigation tests wait for phone history transitions before teardown. Tutorial fonts are pinned and checksum-verified, CI actions use Node 24 runtimes on Ubuntu 24.04, and contributors share one interface design reference.

## Update

No migration is required from 2.3.0; existing tasks and settings are kept. Node.js 22 or newer and Herdr 0.9.1 or newer are still required. The Board supports herdr-projects 1.2.x, not Shepherdr 2.x; use the checklist above if you already upgraded that plugin. Users upgrading wherdr from 1.x should follow the [2.0 migration guide](https://github.com/afloury/wherdr/blob/v2.4.0/docs/herdr-projects-1x.md).

[Full changelog](https://github.com/afloury/wherdr/blob/v2.4.0/CHANGELOG.md)
