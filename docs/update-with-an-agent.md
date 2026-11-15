# Update with an agent

The home screen's banner (*wherdr 3.1.0 is out*) has **What's new**, the release notes rendered
from GitHub, and **Update with Alfred**: it opens Alfred's conversation and sends, as you,
`Update wherdr to <version>: <release URL>`. Alfred lives in herdr-core, so it outlives wherdr's
restart and checks the result. Alfred reads this page from the installed checkout and the
release's notes each time, never from memory. Any other agent can follow it too: paste the steps
below with the version you want.

## Steps

```text
Update the wherdr v3 that runs on this machine to <version> (release: <release URL>), keeping its data.

Rules:
- Work as my user. Never run sudo without asking me first. Never touch a wherdr v2 that may run here.
- Never start or restart hc (herdr-core): its terminals and agents, you included, keep running across a wherdr update.

Steps:
1. Find how v3 runs: systemctl --user cat wherdr-v3 (or the unit whose ExecStart runs .output/server/index.mjs with HC_SOCKET), its WorkingDirectory (the checkout), DATA_DIR and PORT. Note the running version: curl -fsS http://127.0.0.1:<port>/api/health, and the commit: git -C <checkout> rev-parse HEAD.
2. Read the release's notes (gh release view v<version> --repo afloury/wherdr, or the release URL). Its "## Upgrade notes" section, when there is one, lists manual steps or migrations: they are part of the plan.
3. Show me the plan (unit, checkout, DATA_DIR, backup path, the commands below, the upgrade notes' steps) and wait for my yes.
4. Back up the data folder: cp -a <DATA_DIR> <DATA_DIR>.bak-<old version>-$(date +%F).
5. If the install folder (the checkout's parent, with src/ and data/) has update.sh (made by install-v3-beside-v2.sh), run it with the version: update.sh <version> installs the tag v<version> (without it, the branch tip). It builds into src/.output.next and swaps it in only once built, the previous build kept as src/.output.prev: a failed build leaves the running one. Otherwise, in the checkout: git pull, npm ci, npm run build, then systemctl --user restart <unit>. The build needs about 1.5 GB of Node heap: if node -p 'require("v8").getHeapStatistics().heap_size_limit' is smaller, build with NODE_OPTIONS=--max-old-space-size=1536 (update.sh does it itself). Then follow the upgrade notes' steps.
6. Check: /api/health answers with <version> or newer, systemctl --user status <unit> is active, and journalctl --user -u <unit> -n 50 shows no error.
7. On failure: say which step failed and its last lines of output, then roll back: stop the unit; if the new build was swapped in and <checkout>/.output.prev exists, move <checkout>/.output aside and <checkout>/.output.prev back to <checkout>/.output (else git -C <checkout> checkout <old commit>, npm ci, npm run build); restore the backup (move <DATA_DIR> aside, cp -a the backup back), start the unit, and check /api/health shows the old version.
8. End with a short summary: old and new version (and commits), the backup's path, what the upgrade notes asked, and anything I must do (reload the app).
```

The release's *Upgrade notes* are written by whoever publishes it ([RELEASING](RELEASING.md#release-notes-checklist)).
For an update by hand, see [Updating](installation.md#updating).
