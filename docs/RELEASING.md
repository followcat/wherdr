# Releasing wherdr

Publishing a version requires the user's explicit approval. Never republish a package held
for npm review. No new secret is needed: GitHub uses `GITHUB_TOKEN`, npm uses OIDC Trusted
Publishing (`npm.yml`), and the tap uses the existing optional `HOMEBREW_TAP_TOKEN`.

1. Prepare the version and notes in a PR targeting `develop`, the integration branch.
   `main` only receives reviewed releases; `v2` is no longer an integration branch.
   Require `checks` and `e2e` to be green on the exact preparation head, with the current
   `develop` merged in. After explicit approval, open a release PR from `develop` to `main`
   and require those checks again on its exact head before merging. The site workflow
   deploys relevant changes on pushes to `main`, independently of tags and npm.
2. Set the same version in `package.json`, `package-lock.json` and `herdr-plugin.toml`.
   Move the Unreleased changelog into a dated version entry. Run tests, typecheck and leak
   checks; review and merge this version commit before tagging it.
3. Create the GitHub release as a **draft**, with reviewed English notes under one or more of New / Improved /
   Fixed / Update. Write at least two readable sentences explaining what changed for users,
   then link to the tagged CHANGELOG.md (see the example below). A link alone, including
   "See CHANGELOG.md", is never sufficient. Push its version tag only after these notes are ready.
   The workflow validates the draft before attaching the package and again immediately before
   publication; missing or insufficient notes fail the job. It never generates stable release notes.
4. The tag starts `release.yml` (not `npm.yml`, see step 6). `release.yml` runs `npm pack`
   (prepack builds Nitro, includes `skills/wherdr`, resolves linked packages). It attaches
   `wherdr-X.Y.Z.tgz` and `wherdr-X.Y.Z.tgz.sha256` to the draft. After the package job
   succeeds, it publishes the release with `latest=false`. The public GitHub package is now
   usable; native plugins compare the archive checksum. A failed package job leaves the
   release draft; fix and rerun the failed job.
5. The Homebrew job updates the formula URL and SHA from GitHub, without waiting for npm.
   **The manual Homebrew step is MANDATORY while `HOMEBREW_TAP_TOKEN` is absent**. Wait for `release.yml` to finish successfully first, so its
   archive is public; then run `scripts/bump-homebrew.sh`. Otherwise the legacy update channel
   cannot advance even when npm is ready. A skipped Homebrew job does not complete this step.
   Homebrew still uses npm to install the local archive and fetch its third-party dependency;
   it does not need the new **wherdr version** to be available on npm.
6. Once `publish-release` succeeds, the `npm` job of `release.yml` dispatches `npm.yml`
   (`workflow_dispatch` on the tag, `version=vX.Y.Z`). The release and its archive are then
   public, so `npm.yml` never runs ahead of them. It is dispatched rather than triggered by
   the tag or by a `release: published` event: a release made public with `GITHUB_TOKEN`
   starts no workflow, a dispatch does, and npm Trusted Publishing must keep naming `npm.yml`.
   The `npm` job does not wait for Homebrew. `npm.yml` first asks the registry: if the
   version is already on npm, it succeeds without publishing. Otherwise it checks out the
   tag, checks the versions, downloads and verifies the attached archive, then publishes that
   exact file with provenance. npm moderation may still delay registry availability; never
   retry a successful `npm publish` merely because moderation is pending. The manual trigger
   (`gh workflow run npm.yml --ref main -f version=vX.Y.Z`) stays only for recovery, e.g.
   after merging a workflow fix; a second run of a published version is a no-op.
7. `release-ready.yml` checks hourly and after npm/release workflow completion. Once npm's
   tarball and `latest` tag, and the Homebrew formula are ready, it marks the GitHub release
   `latest`. Existing 1.3.x apps read this marker and can then safely use their npm updater.
   New apps read published stable releases directly, checking npm or the formula for their
   own installation mode. No update notice is offered while that channel is unavailable.

An old plugin can get the release immediately via **U** in Herdr or the one-command installer;
its old in-app Update button waits for the legacy channel. Plugin installation tries the exact
version from GitHub, then npm, then compiles only when neither prebuilt source works. This
includes older releases with no GitHub archive. Keep the previous npm version, GitHub assets,
and Homebrew keg available for automatic health-check rollback.

SHA-256 checks download integrity, not authenticity: the archive and checksum share an origin.
Replacing both defeats this check. npm fallback compares the archive to the SHA-512 integrity
in registry metadata, with the same limitation. There is no signature or build attestation check.

npm provenance identifies the publishing workflow (`npm.yml`); the archive was built by
`release.yml` in the same repository at the requested tagged commit. The automatic dispatch
runs `npm.yml` from the tag itself. On a manual recovery run from `main`, provenance
identifies the workflow's `main` commit, while checkout and version checks use the requested tag. It does not independently attest that separate build workflow (M8);
this limitation is intentionally retained.

Readiness logs name each missing npm or Homebrew condition, and an already-current `latest`
marker is left alone. GitHub disables scheduled workflows in public repositories after 60 days
without repository activity. Check that `release-ready.yml` remains enabled; re-enable it and
run it manually if needed. After re-enabling, workflow-completion and manual checks work too.

## herdr-projects tested version

wherdr installs one herdr-projects release, and offers an update to it on machines with an older
one: `PROJECTS_TESTED` in `shared/projectsPlugin.ts`. `PROJECTS_MIN` (1.2.1) is the oldest
release wherdr still reads; it moves only when wherdr drops one.

To move to a newer herdr-projects release:

1. Download its binary from GitHub (`gh release download vX.Y.Z -R eliasstravik/herdr-projects`)
   and check it against its `.sha256`. Run it with `HOME` set to an empty temporary folder and
   Herdr unreachable. Record `version`, `list --json`, `list --json --archived`,
   `details --json -- <id>`, `show --json -- <id>` and `coordinator --machine --json status`
   into `tests/recordings/herdr-projects-X.Y.Z/` (no personal paths or machine names).
   Also check that `tell`, `approve`, `after`, `archive`, `restore` and `coordinator … tell`
   still take the same arguments.
2. Set `PROJECTS_TESTED` to `X.Y.Z`, and point the recordings test in
   `tests/projectsTasks.test.ts` at the new folder.
3. If the release adds a feature worth naming, add it to `FEATURES` in
   `app/components/ProjectsPluginSettings.vue` (the update's one-line summary, FR + EN).
4. Run `npx vitest related --run shared/projectsPlugin.ts`: `tests/projectsPlugin.test.ts`
   fails until the install commands in `docs/board.md`, `docs/herdr-projects-1x.md` and
   `website/public/agent.md` name the new release.

## Release notes checklist

- Summarize the changes in English under `## New`, `## Improved`, `## Fixed` or `## Update`;
  omit categories with no relevant changes. Use complete sentences, at least two in total
  (at least twelve words), describing the user-visible behavior and any required upgrade action.
- Put the full changelog link after the summary, using the release tag rather than `main`.
- Review the text against that version's changelog. The automated check enforces structure
  and minimum content; the reviewer checks accuracy and clarity.
- Validate the exact draft text locally before pushing the tag:
  `GITHUB_REPOSITORY=example/wherdr GITHUB_REF_NAME=vX.Y.Z node scripts/check-release-notes.mjs < /tmp/wherdr-X.Y.Z.md`.
  If the workflow refuses the notes, edit the draft and rerun the failed jobs.

Example (replace `example/wherdr` and the version, and describe the actual release):

```markdown
## Improved
File downloads now work with the supported Node versions. Temporary download links
are released after the browser saves the file, keeping repeated downloads reliable.

[Full changelog](https://github.com/example/wherdr/blob/vX.Y.Z/CHANGELOG.md)
```

## Rolling develop prerelease

`develop-prerelease.yml` rebuilds one prerelease for each commit of the `develop` branch (the
integration branch; `main` only receives releases) that passes CI, so a machine can install develop from a prebuilt package (the plugin's GitHub download) and never compile it.

It starts on `workflow_run` when the `ci` workflow (`ci.yml`, `name: ci`) completes for a push
to `develop`, and only goes on when that run succeeded. It builds exactly the commit that run
tested (`workflow_run.head_sha`), not the current head of `develop`: pull requests no longer
have to be up to date before merging, so two green pull requests can still break `develop`
together, and such a commit is never published. Before building, `scripts/prerelease.sh gate`
checks through the API that:

- a push run of `ci.yml` on `develop` for that commit succeeded with its `checks` and `e2e`
  jobs green;
- the commit is on `develop` (its head or an ancestor);
- the commit is not older than the one the `develop` tag already names. Runs can finish out
  of order: an older commit is then skipped, never published over a newer one.

Any API error stops the gate and the run fails: an unreadable tag is never taken for a
missing one.

A manual run (`workflow_dispatch`, on `develop` only) builds the head of `develop` under the
same gate, so it too needs a green CI run for that commit. Runs never overlap and are never
cancelled halfway. GitHub reads `workflow_run` triggers from the default branch (`main`): a
change to this trigger takes effect once it is released to `main`.
It always publishes the fixed tag **`develop`**, including stable package versions.
The package version stays unchanged; `COMMIT` identifies the build. Existing
`vX.Y.Z-dev` prereleases are left alone.

- the tag moves to the published commit; the release is a prerelease, never `latest`. The update
  checks of every version, the legacy channel and `release-ready.yml` only read stable
  `vX.Y.Z` releases, so none of them offers it;
- `wherdr-<version>.tgz` and `.tgz.sha256` are made as in `release.yml` (`npm pack`,
  `sha256sum`) and replaced; the archive must hold the built server, `bin` with
  `bin/lib/install-skill.sh`, `package.json` and `skills/wherdr/SKILL.md`, and no native code
  (`.node`, `binding.gyp`, `prebuilds`, ELF or Mach-O files): the same file runs on
  linux-arm64 and x64;
- `COMMIT` holds the full SHA of the packaged commit, also written in the notes. It is removed
  before the archive is replaced and attached last: when `COMMIT` is there, the archive is
  that commit's. It can lag behind the head of `develop` while CI runs, or when the head's
  CI failed.

The Pi reads `releases/tags/develop`, never `releases/latest`. Download `COMMIT`,
the single `wherdr-<version>.tgz` asset and `wherdr-<version>.tgz.sha256`.
For 2.1.0 these are `wherdr-2.1.0.tgz` and `wherdr-2.1.0.tgz.sha256`.
Verify the checksum and install the archive through the existing prebuilt-package
installation path. Read `COMMIT` again after downloading and retry if it changed
or is absent: publication can overlap a download. Previous version assets are removed.

The workflow sets `PRERELEASE_TAG=develop` for `scripts/prerelease.sh`. Its notes
identify the branch and commit even when release preparation has emptied Unreleased.
Without that setting, the script keeps the historical `vX.Y.Z-suffix` mode and its
Unreleased summary requirement. Both modes refuse to edit a release unless it is
a published prerelease. The fixed tag does not match stable version tags; its
`GITHUB_TOKEN` update also starts neither `release.yml` nor `npm.yml`. Stable
publishing, update checks and readiness workflows remain unchanged.

## Publishing the prepared 2.1.0 release

The preparation PR targets `develop`. Version 2.1.0 includes new task description editing,
bulk archiving and task limit controls as well as fixes, so it uses a minor increment from
2.0.1 rather than the initially proposed 2.0.2 patch. It introduces no intended breaking
change and needs no migration from 2.0.1.

After explicit approval, merge the reviewed preparation PR into `develop`, then review a
`develop` → `main` release PR. Require `checks` and `e2e` on the exact release head;
run the full CI workflow manually on that head before publication (release tags also run
full CI, but the publishing workflows do not wait for it). Do not tag or create even a
GitHub draft until these checks and the publication approval are complete.

In a clean checkout of the approved `main` commit, using Node.js 22:

```sh
git fetch origin
git merge --ff-only origin/main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(node -p "require('./package.json').version")" = 2.1.0
GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner -q .nameWithOwner)" GITHUB_REF_NAME=v2.1.0 node scripts/check-release-notes.mjs < docs/release-notes-2.1.0.md
git tag v2.1.0
# Prepare the reviewed draft before the tag push starts publication.
gh release create v2.1.0 --target "$(git rev-parse HEAD)" --draft --title "wherdr 2.1.0" --notes-file docs/release-notes-2.1.0.md
git push origin v2.1.0
```

Verify that `release.yml` and full tag CI actually started on the approved SHA; `npm.yml`
starts later, from the `npm` job of `release.yml`, once the release is published.
If the existing tag push does not trigger them, stop and resolve the workflow trigger;
never move the tag or publish a different build. `release.yml` has no manual trigger.
Wait for packaging and publication to succeed, then perform the mandatory manual tap update
when the optional tap secret is absent:

```sh
sh scripts/bump-homebrew.sh 2.1.0 "$(gh repo view --json owner -q .owner.login)"
gh workflow run release-ready.yml --ref main
```

Do not manually publish the draft or mark it latest. npm publishes the attached archive
with provenance; npm moderation can delay availability. Readiness advances the legacy
channel only when npm and Homebrew are both ready. Never retry a successful npm publish.
