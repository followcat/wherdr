# Notifications

[Documentation](README.md) · [Project](../README.md)

## Notifications

With notifications enabled on a device, wherdr sends a Web Push when an agent **needs you** (its
terminal becomes blocked, or errors) or has **finished** (it goes from working to idle or done).
These come from herdr-core's events, with herdr-app's rules: nothing for a sub-agent (a terminal
with a parent), at most one push per terminal, turn and kind, only if the state still holds after
a short settle, and none for an agent currently on screen. Details in
[herdr-core › Notifications](core.md#notifications).

**Do not disturb** (top of Settings → Notifications) stops every push, for this device or for all
devices, for 1 hour, until 8 am or until turned back on. The server applies it before sending and
keeps it across restarts (`data/quiet.json` for all devices). While it is on, the agent list
shows one line, “Notifications silenced until 08:00”, that opens these settings (a crossed-out bell
under the counters when the list is collapsed).

## A default and exceptions

Settings → Notifications stores one policy, synchronized across devices
(`notificationRules` in `settings.json`): **a default for everything, and
exceptions to that default**. Every setting uses the same scale:

| Level | Notifies for |
|---|---|
| **Muted** | nothing |
| **Needs you** | an agent waiting for you (questions, permission requests) |
| **Needs you + finished** | also an agent that finished its turn |
| **All activity** | everything above |

The screen reads top to bottom:

1. **Do not disturb** turns off every notification, no exceptions: the default and
   the exceptions are ignored while it is on.
2. **Default (applies to everything)**: a level (needs you + finished at first).
3. **Exceptions**: **Add an exception** picks an agent conversation, with its own level;
   removing one goes back to the default. Right-click → **Notifications** on an agent sets its
   exception: the levels, **Mute for 1 hour / 8 hours** and **Follow the default**.
   Alfred's or a project coordinator's exception belongs to the coordinator, not its
   conversation: it is listed under its current name (**Alfred**, **SHOP coordinator**) and
   still applies after a restart or on another machine. Coordinator exceptions saved by older
   versions move to Alfred (the main coordinator) or to their project's coordinator; those of
   a machine coordinator or a removed project are dropped, since nothing can match them. An
   exception on a machine wherdr no longer knows shows **Unknown machine**.
4. **This device's notifications** only asks this browser or phone for permission to
   show push notifications, and shows whether it is allowed, blocked or not asked yet.
   Below it, every registered device is listed with the result of the last push sent to it:
   delivered, expired (404/410: the browser dropped the subscription), rejected (401/403),
   push service unreachable, or failed with its HTTP status. Each device keeps its own result,
   so one device's success never hides another's failure. An expired device is no longer
   tried; **Remove** forgets it (otherwise it goes away on its own after 30 days). Only the
   time, the class and the status code are stored in `data/push.json`, never the push
   service's response.

An open conversation suppresses push to **every** device while the page is visible,
focused and recently used (within two minutes). A WebSocket heartbeat renews a
30-second lease every 10 seconds. Hiding, closing, losing the connection or leaving
an idle tab stops renewing it; push resumes when the last lease expires. The global
Do not disturb setting and notification deduplication still apply.

## v2 only

In wherdr v2 on Herdr, wherdr also relays `herdr notification show` notices (as a passive Herdr
client). herdr-core has no such notices.
