# Files

[Documentation](README.md) · [Project](../README.md)

- **Browse files** (agent's **…** menu): a read-only browser of the agent's folder, confined to
  the Git root that holds it (or the folder itself). Every resolved path, symbolic links
  included, must stay under that root; nothing is ever written.
- **Preview** text and code (first 256 KB), images (up to 2 MB), PDFs and videos, and
  **download** any file up to 50 MB. **Open** shows a PDF or a video in a new tab.
- **Markdown** files show formatted (**Rendered**) or as their source with line numbers
  (**Source**). A link to another file of the folder opens its preview, at the heading it names;
  **Back** returns to the previous file. A link that leads outside the folder is refused.
- <a id="paths-in-a-conversation"></a>**Paths in a conversation**: a file path an agent writes
  in its reply (relative, `~/…` or absolute, `/tmp/…` included) opens the same preview. Which files
  it may open is set in Settings › Security › **Files shown from conversations**:
  **Everything my user can read**, **Home and the agents' temporary folders** (`/tmp`, `/var/tmp`,
  `/var/folders`) or **Home only**. With no choice saved: everything while wherdr answers only
  this computer and your tailnet; home and temporary folders once it is reachable from the
  Internet (Tailscale Funnel, `WHERDR_TRUSTED_NETWORKS=any`), where choosing everything shows a
  warning. wherdr reads as your user, so Unix permissions still apply; a symlink is followed on
  the machine and must land in an allowed folder; the size limits are the same.
- **Remote agents**: on this machine the files are read from disk; on a core machine they are
  read with `machine.exec` on that machine, with the same scripts, and only while it is online.
  macOS may need "Allow full disk access for remote users" (System Settings › General › Sharing ›
  Remote Login) for some folders.

The **Changes** view (Git status and diff, line comments and **Send review**) and worktree
management are v2 only.
