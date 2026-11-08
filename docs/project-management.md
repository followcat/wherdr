# Project management: getting started

wherdr v3 can run your work as tasks on a board: each task goes through the
steps of its project's template, and agents do the steps. Nothing happens until
you turn it on.

The same four steps show in the app, on the **Board** while nothing is set up,
and from **Settings › Projects › Getting started**. Each step shows whether it
is done and has a button that takes you there.

1. **Turn on project management.** In Settings › Projects, switch on
   *Project management*. Off, wherdr changes nothing.
2. **Create or pick a template.** A template is the list of steps a task goes
   through, and who does each one (an agent, you, or wherdr
   itself). Under *Templates*, start from an example, such as `vibe`
   (commit straight to a dev branch, no review), change it if you want and save it.
3. **Give each project a template.** Under *Projects*, add a project (a git
   folder on a machine herdr-core reaches) or pick a template for each one in
   the list. Projects imported from v2 ([Migrate from v2](migrate-from-v2.md))
   have none, and their tasks cannot start without it.
   Quicker: **New › Project** opens a project's coordinator, or adds one from
   a git repository found on the machine, a new or empty folder (created at
   start, `git init` offered), or any folder without git (a folder of several
   projects, for instance). A folder without git needs no template: it has no
   tasks (a task needs git for its own worktree), and its coordinator does the
   work in it directly.
4. **Open the board and start the project coordinator.** Pick the project on
   the Board and press *Start*: the coordinator is the agent you talk to about
   the project. It adds tasks and follows them on the board. Alfred, wherdr's
   assistant at the top of the agent list, coordinates all projects at once
   (see [Home](home.md#alfred)).

Then ask the coordinator for tasks, and answer
what shows under *Your turn* and *Decisions*.

## A task waiting for you

Open a task under *Your turn* and its sheet starts on **To do**: what the task
needs from you and the buttons for it, before its Description, Plan and Log.

- **A visual change to merge**: its screenshots large (swipe between them, tap
  one to zoom; each is labelled phone or desktop), the review's verdict, the PR,
  then *Merge*, or *Send back* with a note: the agent gets your note as what to fix.
- **A review to settle** after several send-backs: each choice the engine offers,
  with what it does.
- **A stopped task**: who stopped it and why, then *Continue*, *Take it as it is*
  or *Archive*, each with what it does.
- **A step that ends with you** (*Merged*, or the step's own button): what to do,
  and its button.
- **An agent's question or permission**: its text, and a button to open that agent.
- **A refused merge or a blocked task**: the reason in plain words, and what you
  can do (try again, start it, open its agent).
