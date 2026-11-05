#!/usr/bin/env bash
# Rolling prerelease of the develop branch (.github/workflows/develop-prerelease.yml).
# PRERELEASE_TAG=develop selects the fixed channel, including stable versions.
# Without it, the historical suffix-only channel remains available.
# Commands: version | gate <sha> | package <tgz> <sha> | publish <tgz> <sha>
# gate decides whether <sha> may be published (see cmd_gate).
# package checks the archive and writes its checksum, COMMIT and notes.
# publish needs gh, GH_REPO and a token that can write contents.
# Existing releases must be published prereleases; stable tags are never moved.
set -euo pipefail

die() { echo "prerelease: $*" >&2; exit 1; }

plugin_version() { sed -n 's/^version = "\(.*\)"$/\1/p' herdr-plugin.toml | head -n 1; }

cmd_version() {
  local version pkg
  version="$(plugin_version)"
  pkg="$(node -p "require('./package.json').version")"
  [ "$version" = "$pkg" ] || die "herdr-plugin.toml ($version) and package.json ($pkg) disagree"
  [ "${PRERELEASE_TAG:-develop}" = develop ] || die "unsupported PRERELEASE_TAG"
  if [ "${PRERELEASE_TAG:-}" = develop ]; then
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid version $version"
    echo "$version"
    return
  fi
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$ ]] \
    || die "version $version is not a prerelease (X.Y.Z-suffix): stable releases go through release.yml"
  echo "$version"
}

check_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "not a full commit SHA: $1"; }

# The archive must hold what fetch_prebuilt installs, and nothing compiled for
# one platform: the same file runs on linux-arm64 (Raspberry Pi) and x64.
check_archive() {
  local tgz="$1" tmp missing=0 native
  tmp="$(mktemp -d)"
  tar -xzf "$tgz" -C "$tmp"
  for entry in .output/server/index.mjs bin/wherdr.mjs bin/lib/install-skill.sh bin/lib/verify-release.mjs \
    scripts/fetch-dictation-files.mjs scripts/dictation-files.mjs app/utils/dictation/models.json package.json; do
    [ -f "$tmp/package/$entry" ] || { echo "prerelease: missing package/$entry" >&2; missing=1; }
  done
  native="$(node -e '
    const fs = require("node:fs"), path = require("node:path")
    const MAGIC = ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe"]
    const hits = []
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name === "prebuilds") hits.push(p); else walk(p); continue }
        if (!e.isFile()) continue
        if (/\.(node|so|dylib|dll|exe)$/.test(e.name) || e.name === "binding.gyp") { hits.push(p); continue }
        const fd = fs.openSync(p, "r"), b = Buffer.alloc(4)
        const n = fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd)
        if (n === 4 && MAGIC.includes(b.toString("hex"))) hits.push(p)
      }
    }
    walk(process.argv[1])
    console.log(hits.map(h => path.relative(process.argv[1], h)).join("\n"))
  ' "$tmp")"
  rm -rf "$tmp"
  [ "$missing" = 0 ] || die "incomplete package $tgz"
  [ -z "$native" ] || die "native code in the package (it would not run on another platform):
$native"
}

cmd_package() {
  local tgz="${1:?usage: prerelease.sh package <tgz> <sha>}" sha="${2:?commit SHA}" version dir name
  check_sha "$sha"
  version="$(cmd_version)"
  name="wherdr-$version.tgz"
  [ "$(basename "$tgz")" = "$name" ] || die "expected $name, got $(basename "$tgz")"
  check_archive "$tgz"
  dir="$(dirname "$tgz")"
  # The format bin/lib/verify-release.mjs reads, as release.yml writes it.
  (cd "$dir" && sha256sum "$name" > "$name.sha256")
  printf '%s\n' "$sha" > "$dir/COMMIT"
  if [ "${PRERELEASE_TAG:-}" = develop ]; then
    # Release preparation can leave Unreleased empty; the channel still publishes.
    printf '## Update\n\nThis package follows the develop branch at the commit below. Read CHANGELOG.md in the archive for the changes included in this build.\n' > "$dir/prerelease-notes.md"
  else
  node "$(dirname "${BASH_SOURCE[0]}")/prerelease-summary.mjs" "$sha" > "$dir/prerelease-notes.md"
  fi
  {
    echo
    echo "Rolling prerelease of the \`develop\` branch, rebuilt for each develop commit that passes CI. Not a stable release: never marked latest, never offered as an update."
    echo
    echo "Commit: \`$sha\`"
    echo
    echo "Built $(date -u '+%Y-%m-%d %H:%M UTC')${GITHUB_RUN_ID:+ by ${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/$GITHUB_RUN_ID}."
    echo
    echo "\`COMMIT\` holds the commit of \`$name\`. It is removed while the files are replaced and attached last: when it is present, the archive matches it."
  } >> "$dir/prerelease-notes.md"
  echo "prerelease: $name for $sha checked"
}

# A develop commit is published only when:
# - a push run of ci.yml on develop for exactly this commit succeeded, with its
#   `checks` and `e2e` jobs green (the checks the branch protection requires);
# - it is on develop (develop's head or one of its ancestors);
# - it is not older than the commit the develop tag already names: runs can
#   finish out of order, and a newer build is never replaced by an older one.
# Writes publish=true|false to $GITHUB_OUTPUT. Fails when CI is not green or the
# commit is not on develop; an older commit is skipped without failing.
cmd_gate() {
  local sha="${1:?usage: prerelease.sh gate <sha>}" repo runs run run_ok="" jobs head published status
  check_sha "$sha"
  repo="${GH_REPO:?GH_REPO is required}"
  # Every API call fails closed: an error stops the gate, never lets a commit through.
  runs="$(gh api "repos/$repo/actions/workflows/ci.yml/runs?head_sha=$sha&event=push&branch=develop&status=success&per_page=20" \
    --jq '.workflow_runs[] | select(.head_sha == "'"$sha"'" and .conclusion == "success") | .id')" \
    || die "could not list the ci runs of $sha"
  for run in $runs; do
    jobs="$(gh api "repos/$repo/actions/runs/$run/jobs?per_page=100" --jq '.jobs[] | select(.conclusion == "success") | .name')" \
      || die "could not read the jobs of ci run $run"
    if printf '%s\n' "$jobs" | grep -qx checks && printf '%s\n' "$jobs" | grep -qx e2e; then
      run_ok="$run"; break
    fi
  done
  [ -n "$run_ok" ] || die "no successful ci run (checks and e2e) on develop for $sha"
  head="$(gh api "repos/$repo/branches/develop" --jq .commit.sha)" || die "could not read the head of develop"
  check_sha "$head"
  if [ "$head" != "$sha" ]; then
    status="$(gh api "repos/$repo/compare/$head...$sha" --jq .status)" || die "could not compare $sha with develop"
    [ "$status" = behind ] || die "$sha is not on develop ($status relative to $head)"
  fi
  # matching-refs answers an empty list when the tag does not exist yet, so a
  # failed call is never mistaken for a missing tag.
  published="$(gh api "repos/$repo/git/matching-refs/tags/develop" --jq '.[] | select(.ref == "refs/tags/develop") | .object.sha')" \
    || die "could not read the develop tag"
  if [ -n "$published" ] && [ "$published" != "$sha" ]; then
    check_sha "$published"
    status="$(gh api "repos/$repo/compare/$published...$sha" --jq .status)" || die "could not compare $sha with the published $published"
    case "$status" in
      behind)
        echo "prerelease: develop already names $published, newer than $sha: skipped"
        [ -z "${GITHUB_OUTPUT:-}" ] || echo "publish=false" >> "$GITHUB_OUTPUT"
        return ;;
      ahead|diverged) ;;
      *) die "unexpected comparison of $sha with the published $published: $status" ;;
    esac
  fi
  echo "prerelease: $sha passed ci run $run_ok and may be published"
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "publish=true" >> "$GITHUB_OUTPUT"
}

cmd_publish() {
  local tgz="${1:?usage: prerelease.sh publish <tgz> <sha>}" sha="${2:?commit SHA}" version tag dir repo state assets exists
  check_sha "$sha"
  version="$(cmd_version)"
  tag="${PRERELEASE_TAG:-v$version}"
  dir="$(dirname "$tgz")"
  repo="${GH_REPO:?GH_REPO is required}"
  for f in "$tgz" "$tgz.sha256" "$dir/COMMIT" "$dir/prerelease-notes.md"; do
    [ -f "$f" ] || die "missing $f (run: prerelease.sh package first)"
  done

  if state="$(gh release view "$tag" --json isPrerelease,isDraft --jq '"\(.isPrerelease) \(.isDraft)"' 2>/dev/null)"; then
    [ "$state" = "true false" ] || die "release $tag exists and is not a published prerelease ($state): left alone"
    # Gone while the archive changes: a reader that finds COMMIT finds its archive.
    assets="$(gh release view "$tag" --json assets --jq '.assets[].name')"
    if printf '%s\n' "$assets" | grep -qx COMMIT; then
      gh release delete-asset "$tag" COMMIT --yes
    fi
    exists=1
  else
    exists=0
  fi

  # The tag follows the pushed commit. Made with the workflow's token, it starts
  # no other workflow (release.yml and npm.yml listen to v* tags).
  if gh api "repos/$repo/git/refs/tags/$tag" >/dev/null 2>&1; then
    gh api -X PATCH "repos/$repo/git/refs/tags/$tag" -f sha="$sha" -F force=true >/dev/null
  else
    gh api -X POST "repos/$repo/git/refs" -f ref="refs/tags/$tag" -f sha="$sha" >/dev/null
  fi

  if [ "$exists" = 1 ]; then
    gh release edit "$tag" --prerelease --latest=false --title "wherdr $version" --notes-file "$dir/prerelease-notes.md"
  else
    gh release create "$tag" --verify-tag --prerelease --latest=false --title "wherdr $version" --notes-file "$dir/prerelease-notes.md"
  fi
  gh release upload "$tag" "$tgz" "$tgz.sha256" --clobber
  # Keep exactly one archive and checksum on the fixed channel after version bumps.
  if [ "$exists" = 1 ] && [ "$tag" = develop ]; then
    while IFS= read -r asset; do
      case "$asset" in
        wherdr-*.tgz|wherdr-*.tgz.sha256)
          [ "$asset" = "$(basename "$tgz")" ] || [ "$asset" = "$(basename "$tgz").sha256" ] \
            || gh release delete-asset "$tag" "$asset" --yes ;;
      esac
    done <<< "$assets"
  fi
  gh release upload "$tag" "$dir/COMMIT" --clobber
  echo "prerelease: $tag now at $sha"
}

case "${1:-}" in
  version) cmd_version ;;
  gate) shift; cmd_gate "$@" ;;
  package) shift; cmd_package "$@" ;;
  publish) shift; cmd_publish "$@" ;;
  *) die "usage: $0 version | gate <sha> | package <tgz> <sha> | publish <tgz> <sha>" ;;
esac
