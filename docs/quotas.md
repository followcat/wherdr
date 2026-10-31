# Claude and Codex quotas

[Documentation](README.md) · [Project](../README.md)

- **Codex updates and limits**: in a Codex conversation, a new Codex version shows above the
  field with an **Update** button (runs Codex's official update command on that machine, after
  confirmation), then **Restart to update** on the same conversation. When wherdr cannot run it
  (read-only home), Update exits Codex, runs the command in the agent's own terminal and
  resumes the same conversation (only while Codex is idle). Codex's own weekly-limit warning
  (its footer gauge, or its startup heads-up) is repeated above the field, with its values, while
  Codex shows it.
- **After Codex updates itself and exits**: a **Your turn** card offers **Restart Codex**
  for a new conversation, with the original launch arguments. For an existing conversation,
  choose **Resume conversation** (its exact session, with the original options) or **Start
  fresh**. If wherdr cannot identify the session, Resume opens Codex's picker rather than
  choosing another pane's latest conversation. The usual attention notification applies.
  Nothing restarts automatically: the pane must still show the same empty shell prompt,
  with the shell in the foreground. Unrecognized shell prompts require a manual restart
  in the terminal. wherdr must have observed Codex before it exited.
  **Dismiss** puts the card away for good: the pane is a plain shell again, to use as you like.
  Messages sent meanwhile wait in the queue until the agent returns; if it does not (Dismiss, or
  a Codex that simply left), their text goes back into the pane's message field. Continuation
  prompts (unfinished quotes or heredocs) refuse a restart too. If the final
  transcript read fails, both conversation choices remain available; a session
  contradicted by a guessed match is resumed through Codex's picker.
## Claude and Codex quotas

The home screen shows what is left of the Claude and Codex usage limits (5-hour window and
week, with reset times), for every online machine.

- **Codex**: nothing to do, Codex writes its limits in its session files. Machines on different
  Codex accounts get one block each (told apart by a short hash of the account ID found in the
  session files; `~/.codex/auth.json` is never read).
- **Claude Code** only gives them to its status line. On each machine, install wherdr's
  invisible status line (it displays nothing, and chains to your existing status line if you
  have one):

  ```sh
  sh scripts/install-claude-statusline.sh
  ```

  The app offers the same thing in **Settings › Agents › Claude quotas**: each machine with
  Claude, its state (set up, installed, update available, not set up), **Install** or **Update**
  (runs it over SSH on a remote machine) and **Copy command**. The setup guide has it as an
  optional **Quotas** step, and the home list only adds **Set up Claude quotas** and **Don’t
  suggest again** to the machine's **…** menu, never a banner. Skipped or declined, it is no
  longer suggested on any device (`data/claude-quotas.json`); Settings still offers it. A machine
  whose quotas show from an older status line reads **Update available**, never "not set up".
  Quotas show after the next exchange with a Claude agent. The status line stores the limits in `~/.cache/herdr-web/claude-status.json`
  and a short hash of the account ID (never a token or email) to tell accounts apart. The hash
  and observation time are stored together with the limits in one atomic snapshot, so a
  new login takes effect on the next status-line update. Machines sharing a known account
  use its newest snapshot; an unknown identity never overrides a known account. A failed
  Claude read is retried once;
  if both attempts fail, its previous identity is not reused. This prevents an old
  successful reading from masking a newer file indefinitely during SSH failures.
  Failed attempts are logged with the machine key and error code, without account data.
  After upgrading from the older status
  line, rerun the install command on each machine (or use **Install**) and exchange a message
  with Claude to produce the new snapshot. The status line also requires `python3` in Claude’s
  `PATH` at runtime.

  **API billing** (API key or Anthropic Console credits): Claude Code passes no rate limits, so
  once a session has had an API response the status line keeps its snapshot without them, and
  the machine reads **API usage (no quota)** in Settings and *Claude · API usage, no quota* on the
  home screen (no gauge, no setup prompt); switching back to a subscription shows the gauges
  again after the next exchange. Status lines installed before this need **Update**.

  **New machine**: run `sh scripts/install-claude-statusline.sh` on it once (or **Install** in
  Settings › Agents › Claude quotas), then send a message to any Claude agent there; its quotas
  appear on the home screen.
