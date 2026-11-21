wherdr 3.2.2 brings back **Open in editor** on v3 and fixes **omp**: its conversations open again from herdr-core terminals, its status shows when an extension adds a status line, an omp coordinator keeps coordinating, and a project's default workflow runs on its coordinator's agent. Thanks to [@SunnySydeUp](https://github.com/SunnySydeUp) for the omp fixes. Update as usual: the banner's *Update with Alfred*, or `update.sh 3.2.2` in the install folder.

## New

**Open in editor is back.** Mod+Alt+O, or *Open in editor* in an agent's **…** menu, opens the agent's folder in the default editor of the Mac it runs on, this computer or another machine. Only a folder under that machine's home opens, and a machine that is not a Mac says so.

## Fixed

**omp conversations.** The conversation of an omp agent running in a herdr-core terminal opens again, sessions that start with omp's title line included. (#973)

**An omp coordinator keeps coordinating.** A project coordinator on omp could follow a pasted command or one of your rules and do a task's work itself. It now has the coordinator's role in its system prompt: it adds and starts tasks for task agents and never does the work in its own conversation. (#973)

**omp status with an extension.** When an omp extension adds a status line under omp's footer, the conversation view still shows the context gauge, quota meters and model. (#974)

**A project's default workflow.** Until you accept a workflow, an omp coordinator's tasks now run on omp with its model instead of on Claude, and a workspace member without a workflow of its own uses its workspace coordinator's agent. Claude and Codex coordinators keep the Claude default, and an accepted workflow keeps its own agents. (#975)

## Upgrade notes

An omp project coordinator that is already running keeps its old prompt until it restarts. To give it the coordinator's role now, close its terminal and start it again from *New › Project › Restart a coordinator*; it picks up its conversation where it left off. Claude and Codex coordinators need nothing.

[Full changelog](https://github.com/afloury/wherdr/blob/v3.2.2/CHANGELOG.md)

Join us on Discord: https://discord.gg/ky36WYmtVE
