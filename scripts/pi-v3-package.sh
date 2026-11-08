#!/usr/bin/env bash
# Packs the v3 app built in this checkout (`npm run build`) for scripts/pi-deploy-v3.sh, into
# <out-dir>, the folder the Pi reads (served on the tailnet, for example). Run it on the
# machine that builds, never on the Pi.
#   pi-v3-package.sh <out-dir> [<sha>]   (sha: the commit that was built, default HEAD)
# <out-dir> gets wherdr-v3.tgz (.output + COMMIT), wherdr-v3.tgz.sha256 and COMMIT. COMMIT is
# removed first and written last: when it is there, the archive is that commit's.
set -euo pipefail

ASSET=wherdr-v3.tgz
MAX_MB="${PI_V3_PACKAGE_MAX_MB:-80}"

die() { echo "pi-v3-package: $*" >&2; exit 1; }

# Native code would only run on the building machine's platform: the archive must run on
# linux-arm64 (Raspberry Pi) whatever built it, so it holds JavaScript and assets only.
native_files() {
  find "$1" \( -type d -name prebuilds -prune -print \) -o \( -type l -print \) -o \( -type f \( \
    -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -name '*.dylib' -o -name '*.dll' -o -name '*.exe' -o -name binding.gyp \) -print \) \
    -o \( -type f -size +3c -exec sh -c 'for f; do m=$(head -c 4 "$f" | od -An -tx1 | tr -d " \n"); case $m in 7f454c46|feedface|feedfacf|cefaedfe|cffaedfe) echo "$f";; esac; done' sh {} + \)
}

out="${1:?usage: pi-v3-package.sh <out-dir> [<sha>]}"
sha="${2:-$(git rev-parse HEAD 2>/dev/null || true)}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "not a full commit SHA: '$sha'"
[ -f .output/server/index.mjs ] || die "no .output/server/index.mjs here: run npm run build first"
# The Pi checks that /api/health answers this version (shared/v3Version.ts).
grep -rqF "3.0.0-dev+${sha:0:7}" .output/server || die ".output was not built from ${sha:0:7} (its version differs): rebuild, or pass the built commit"

# Nitro links some packages (.nitro/<name>@<version>): replaced by copies, as npm pack does.
[ ! -d .output/server/node_modules/.nitro ] || node "$(dirname "$0")/pack-output.mjs" >/dev/null
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -a .output "$tmp/.output"
printf '%s\n' "$sha" > "$tmp/COMMIT"
bad="$(native_files "$tmp")"
[ -z "$bad" ] || die "native code or links in the build (it would not run on the Pi):
${bad//$tmp\//}"
tar -czf "$tmp/$ASSET" -C "$tmp" .output COMMIT
size=$(( $(stat -c %s "$tmp/$ASSET") / 1048576 ))
[ "$size" -le "$MAX_MB" ] || die "$ASSET is $size MB, more than $MAX_MB MB"
(cd "$tmp" && sha256sum "$ASSET" > "$ASSET.sha256")

mkdir -p "$out"
rm -f "$out/COMMIT"
mv "$tmp/$ASSET" "$out/$ASSET.part" && mv "$out/$ASSET.part" "$out/$ASSET"
mv "$tmp/$ASSET.sha256" "$out/$ASSET.sha256"
printf '%s\n' "$sha" > "$out/COMMIT"
echo "pi-v3-package: $out/$ASSET for ${sha:0:7} ($size MB)"
