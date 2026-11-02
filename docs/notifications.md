# Notifications

[Documentation](README.md) · [Project](../README.md)

## Notifications

With notifications enabled on a device, wherdr sends a Web Push when an agent goes from working
to **blocked** (with its question and options) or to **done** (with the start of its answer).
There is no push for the agent currently on screen.

**Do not disturb** (top of Settings → Notifications) stops every push, for this device or for all
devices, for 1 hour, until 8 am or until turned back on. The server applies it before sending and
keeps it across restarts (`data/quiet.json` for all devices). While it is on, the agent list
shows one line, “Notifications silenced until 08:00”, that opens these settings (a crossed-out bell
under the counters when the list is collapsed); the header keeps its buttons as they are.

wherdr also relays custom notifications sent with `herdr notification show` (plugins, scripts).
To receive them it connects to Herdr's client socket as a **passive** client: it never becomes
the foreground client and never resizes anything. Side effects: with wherdr connected,
`notification show` reports `shown: true` even with no terminal attached, and an empty session
gets a default workspace, as with any attached client.

## A default and exceptions

Settings → Notifications stores one policy, synchronized across devices
(`notificationRules` in `settings.json`): **a default for everything, and
exceptions to that default**. Every setting uses the same scale:

| Level | Notifies for |
|---|---|
| **Muted** | nothing |
| **Needs you** | a task or a coordinator waiting for you (questions, permission requests, board approvals) |
| **Needs you + finished** | also a finished task, or a coordinator that finished answering you |
| **All activity** | also every intermediate message and scheduled tasks |

Under each level, **Customize** keeps the individual events (needs you, finished,
new message, scheduled task) for edge cases.

The screen reads top to bottom:

1. **Do not disturb** turns off every notification, no exceptions: the default and
   the exceptions are ignored while it is on.
2. **Default (applies to everything)**: a level (needs you + finished at first)
   and a **Sub-agents** switch. Off, only coordinators, standalone agents and board
   events notify; on, task agents (workers, reviewers, planners, attempts) notify
   too, at the same level. Sub-agents are all on or all off, never task by task.
3. **Exceptions**: **Add an exception** picks a coordinator (main, machine or project
   coordinator, grouped by machine) or a standalone agent conversation. Each one has
   its own level, Customize and, for a coordinator, a Sub-agents switch: on, the task
   agents of its board follow the exception instead of the default (a project
   coordinator covers its project's tasks; the main and machine coordinators cover the
   others). Each says how it differs from the default; removing one goes back to it.
4. **This device's notifications** only asks this browser or phone for permission to
   show push notifications, and shows whether it is allowed, blocked or not asked yet.
   Below it, every registered device is listed with the result of the last push sent to it:
   delivered, expired (404/410: the browser dropped the subscription), rejected (401/403),
   push service unreachable, or failed with its HTTP status. Each device keeps its own result,
   so one device's success never hides another's failure. An expired device is no longer
   tried; **Remove** forgets it (otherwise it goes away on its own after 30 days). Only the
   time, the class and the status code are stored in `data/push.json`, never the push
   service's response.

A coordinator's exception is kept by its identity (machine, Herdr session, level and
repo), not its pane: it still applies after `coordinator new` or a restart.

Right-click → **Notifications** on a coordinator or a standalone agent sets that
conversation's exception: the four levels (with a check mark on the current one, and
whether it is an exception or the default), **Mute for 1 hour / 8 hours** (then back
to what it was), and **Follow the default** to remove the exception. On a task agent,
the menu points to the Sub-agents switch instead.

Board events (`herdr-projects` approvals and failures) follow the default even with
Sub-agents off, or their project coordinator's exception in the task's own Herdr
session (the default when that session is not known: a task with no pane or space linked). Custom `herdr notification
show` notices with a pane follow that conversation; others follow the default. Scripts
can mark a scheduled notice with a `[scheduled]` title prefix. New assistant messages
are identified by their transcript position, so streaming updates do not ring
repeatedly.

Settings saved by the earlier machine → project → conversation rules are converted
once: a permanent machine rule becomes the default (so "Only main coordinators"
becomes default Muted plus one exception), project rules are dropped, and
conversation rules become exceptions (moved to the coordinator's identity when the
conversation is a coordinator).

An open conversation suppresses push to **every** device while the page is visible,
focused and recently used (within two minutes). A WebSocket heartbeat renews a
30-second lease every 10 seconds. Hiding, closing, losing the connection or leaving
an idle tab stops renewing it; push resumes when the last lease expires. The global
Do not disturb setting and notification deduplication still apply.
