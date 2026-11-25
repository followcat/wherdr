# Files

[Documentation](README.md) · [Project](../README.md)

- **Browse files** (agent's **…** menu): a read-only browser of the agent's folder, confined to
  the Git root that holds it (or the folder itself). Every resolved path, symbolic links
  included, must stay under that root; nothing is ever written.
- The folder shows as a **tree** of folders and files with type icons: a folder's content is read
  the first time it opens (a loading row, then an error or **Empty folder.** row when there is
  nothing to list); a big tree draws only its visible rows. **Show hidden files** shows or hides
  dotfiles (kept on the device). Clicking a file shows its preview, beside the tree when the panel
  is wide enough (760 px), else in its place with **Back**; the breadcrumb above the preview opens
  a folder of its path in the tree. **Refresh** reads the open folders and the file again.
- **Preview** text and code (first 256 KB), images (up to 2 MB), PDFs and videos, and
  **download** any file up to 50 MB. **Open** shows a PDF or a video in a new tab.
- **Markdown** files show formatted (**Rendered**) or as their source with line numbers
  (**Source**). A link to another file of the folder opens its preview, at the heading it names;
  **Back** returns to the previous file. A link that leads outside the folder is refused.
  Inline code reads as text there: no glyph, chip or menu on it; a code block keeps **Copy**.
- <a id="one-file"></a>**One file shown alone** (a path clicked in a conversation, or a file an
  agent shows beside it) reads as a document under one compact header: the file's name in small
  type, its folder and size under it, and the controls at their right (Rendered | Source, Open,
  Download, Refresh as icons, Back after a link); on a phone or in a narrow panel the controls
  sit beside the folder. The text takes the window's width with a
  readable line length and no frame; a wide table scrolls inside itself.
- <a id="html-pages"></a>**HTML pages** (`.html`, `.htm`, up to 256 KB: an agent's mockup or demo)
  run as a page (**Preview**, the default) or show their source (**Source**). The page runs in a
  sandboxed frame with its own origin, apart from wherdr: it cannot read wherdr's cookies or
  storage, call its API, open windows, send forms or navigate the app. Self-contained pages only:
  its inline CSS, scripts and images work, as do `https` links to a CDN; files next to it are not
  loaded, and it makes no network requests (`fetch`). **Open** shows it alone in a new tab, under
  the same sandbox.
- <a id="paths-in-a-conversation"></a>**Paths in a conversation**: a file path an agent writes
  in its reply (relative, `~/…` or absolute, `/tmp/…` included) opens the same preview. Which files
  it may open is set in Settings › Security › **Files shown from conversations**:
  **Everything my user can read**, **Home and the agents' temporary folders** (`/tmp`, `/var/tmp`,
  `/var/folders`) or **Home only**. With no choice saved: everything while wherdr answers only
  this computer and your tailnet; home and temporary folders once it is reachable from the
  Internet (Tailscale Funnel, `WHERDR_TRUSTED_NETWORKS=any`), where choosing everything shows a
  warning. While `settings.json` cannot be read, only the home folder opens. wherdr reads as your user, so Unix permissions still apply; a symlink is followed on
  the machine and must land in an allowed folder; the size limits are the same.
- **How a written path is found**: an absolute or `~/…` path is that file. A relative path
  (`plans/x.md`, `app/components/X.vue`) is looked for, in order, in the agent's folder (its home
  when unknown), its project's repository (a task's agent: the task's worktree; a coordinator: its
  project's clone, a workspace's root then each member's clone) and the notes (`plans/…`). The
  chip's menu shows and copies the absolute path found; in two of these folders, it offers both,
  labelled **Agent folder**, **Repository** or **Notes** (a notes file opens in the Notes panel).
  A bare file name (`report.md`) not found is then looked for in the folders quoted before it in
  the same message (`~/project/tasks/ABC-24/`, nearest first), and opens from there.
  A path found nowhere is drawn muted: "Not found in the agent's folder, the repository or the
  notes". The check runs on the machine (symlinks resolved), one request for the new paths of a
  message, kept for the conversation; a folder outside the setting above is skipped and
  protected files are never offered. In a note, inline code naming a notes file (`` `plans/x.md` ``)
  opens it like a link.
- **Remote agents**: on this machine the files are read from disk; on a core machine they are
  read with `machine.exec` on that machine, with the same scripts, and only while it is online.
  macOS may need "Allow full disk access for remote users" (System Settings › General › Sharing ›
  Remote Login) for some folders.

The **Changes** view (Git status and diff, line comments and **Send review**) and worktree
management are v2 only.
