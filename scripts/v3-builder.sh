#!/usr/bin/env bash
# Builder for the Pi's v3 auto-deploy, run on a dev machine (never on the Pi): on each new
# commit of origin/v3 it builds the app once, packs it (scripts/pi-v3-package.sh: no native
# code, so the x86 build runs on linux-arm64) and serves it read-only on the tailnet, where
# scripts/pi-deploy-v3.sh on the Pi pulls it. Nothing is published anywhere else.
#   v3-builder.sh                 build origin/v3 if it moved (what the timer runs)
#   v3-builder.sh setup [--yes]   install the timer (every 3 min) and `tailscale serve` of www/
#   v3-builder.sh remove [--yes]  remove the timer and the serve entry (builds are kept)
#   v3-builder.sh status          last built commit, origin/v3, last log lines
# Folder (WHERDR_V3_BUILDER_DIR, default ~/wherdr-v3-builder): src/ (its own clone), www/
# (what is served: the latest build at the top, the last builds in www/builds/<sha>),
# builds.log (one line per build), last-build.log (output of the last build).
# Settings: WHERDR_V3_REPO (the repository to clone), WHERDR_V3_BRANCH (package.json's
# config.branch), WHERDR_V3_BUILDER_PORT (HTTPS port of the serve entry, 8110),
# WHERDR_V3_KEEP (builds kept, 5), WHERDR_HEAVY_LOCK.
set -euo pipefail

ROOT="${WHERDR_V3_BUILDER_DIR:-$HOME/wherdr-v3-builder}"
PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/package.json"
# Default: the clone's remote, else the repository of the checkout this script is in.
REPO="${WHERDR_V3_REPO:-$(git -C "$ROOT/src" remote get-url origin 2>/dev/null \
  || node -p "require('$PKG').repository.url.replace(/^git\\+/, '')" 2>/dev/null || true)}"
[ -n "$REPO" ] || { echo "v3-builder: set WHERDR_V3_REPO (the repository to clone)" >&2; exit 2; }
# The branch v3 is built from: package.json's config.branch, the one place that names it.
# The installed copy ($ROOT/v3-builder.sh) has no checkout beside it: setup writes the branch
# into the unit (WHERDR_V3_BRANCH); else the clone's package.json.
branch_of() { node -p "require('$1').config?.branch ?? ''" 2>/dev/null || true; }
BRANCH="${WHERDR_V3_BRANCH:-$(branch_of "$PKG")}"
BRANCH="${BRANCH:-$(branch_of "$ROOT/src/package.json")}"
[ -n "$BRANCH" ] || { echo "v3-builder: set WHERDR_V3_BRANCH (no package.json with config.branch)" >&2; exit 2; }
PORT="${WHERDR_V3_BUILDER_PORT:-8110}"
KEEP="${WHERDR_V3_KEEP:-5}"
LOCK="${WHERDR_HEAVY_LOCK:-/tmp/wherdr-heavy.lock}"
SRC="$ROOT/src" WWW="$ROOT/www"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ASSET=wherdr-v3.tgz

log() { mkdir -p "$ROOT"; printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$ROOT/builds.log" >&2; }
die() { log "ERROR $*"; exit 1; }

cmd_build() {
  local head sha
  mkdir -p "$WWW/builds"
  if [ ! -d "$SRC/.git" ]; then git clone -q --branch "$BRANCH" "$REPO" "$SRC" || die "git clone $REPO failed"; fi
  git -C "$SRC" fetch -q origin "$BRANCH" || die "git fetch failed"
  head="$(git -C "$SRC" rev-parse "origin/$BRANCH")"
  [ "$head" != "$(cat "$WWW/COMMIT" 2>/dev/null)" ] || exit 0
  # A commit whose build failed is not retried; the next push is.
  [ "$head" != "$(cat "$ROOT/failed-commit" 2>/dev/null)" ] || exit 0

  exec 9>>"$LOCK"
  flock -w 3600 9 || die "could not take $LOCK in an hour"
  git -C "$SRC" checkout -q -f --detach "$head"
  if ! (cd "$SRC" && { nice -n 10 npm ci --no-audit --no-fund --loglevel=error && nice -n 10 npm run build; } > "$ROOT/last-build.log" 2>&1); then
    printf '%s\n' "$head" > "$ROOT/failed-commit"
    die "build of ${head:0:7} failed: see $ROOT/last-build.log"
  fi
  (cd "$SRC" && bash scripts/pi-v3-package.sh "$WWW/builds/$head" "$head") >> "$ROOT/last-build.log" 2>&1 \
    || { printf '%s\n' "$head" > "$ROOT/failed-commit"; die "packing ${head:0:7} failed: see $ROOT/last-build.log"; }

  # The latest at the top of www/: COMMIT removed first, written last.
  rm -f "$WWW/COMMIT"
  for f in "$ASSET" "$ASSET.sha256"; do cp "$WWW/builds/$head/$f" "$WWW/$f.part" && mv "$WWW/$f.part" "$WWW/$f"; done
  cp "$WWW/builds/$head/COMMIT" "$WWW/COMMIT"
  rm -f "$ROOT/failed-commit"
  # shellcheck disable=SC2012 # build folders are named by SHA
  ls -1t "$WWW/builds" | tail -n +"$((KEEP + 1))" | while read -r sha; do rm -rf "${WWW:?}/builds/$sha"; done
  log "OK built ${head:0:7}"
}

units() {
  local self="$ROOT/v3-builder.sh"
  cat > "$UNITS/wherdr-v3-builder.service" <<EOF
# Builds origin/v3 for the Pi (scripts/v3-builder.sh). Remove with: $self remove --yes
[Unit]
Description=Build wherdr v3 for the Pi when origin/v3 moves
After=network-online.target

[Service]
Type=oneshot
Environment="WHERDR_V3_BUILDER_DIR=$ROOT" "WHERDR_V3_REPO=$REPO" "WHERDR_V3_BRANCH=$BRANCH" "WHERDR_V3_KEEP=$KEEP" "PATH=$PATH"
UnsetEnvironment=CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_ENTRYPOINT HC_SCOPE HC_TERMINAL_ID HC_TERMINAL_SOCKET
ExecStart=/bin/bash "$self"
EOF
  cat > "$UNITS/wherdr-v3-builder.timer" <<EOF
# Every 3 minutes (scripts/v3-builder.sh). Off: systemctl --user disable --now wherdr-v3-builder.timer
[Unit]
Description=Check origin/v3 for a new commit every 3 minutes

[Timer]
OnBootSec=2min
OnUnitInactiveSec=3min

[Install]
WantedBy=timers.target
EOF
}

cmd_setup() {
  local host
  echo "PLAN copy this script to $ROOT/v3-builder.sh; write wherdr-v3-builder.service and .timer in $UNITS; enable the timer"
  echo "PLAN tailscale serve --bg --https=$PORT $WWW (read-only, tailnet only)"
  if tailscale serve status --json 2>/dev/null | grep -q "\.ts\.net:$PORT\"" && ! tailscale serve status 2>/dev/null | grep -qF "$WWW"; then
    echo "ERROR https port $PORT is used by another tailscale serve entry: set WHERDR_V3_BUILDER_PORT" >&2; exit 4
  fi
  [ "${1:-}" = --yes ] || { echo "Dry run: nothing changed. Run again with --yes to apply."; return; }
  mkdir -p "$WWW/builds" "$UNITS"
  cp "${BASH_SOURCE[0]}" "$ROOT/v3-builder.sh"; chmod 755 "$ROOT/v3-builder.sh"
  units
  systemctl --user daemon-reload
  systemctl --user enable --now wherdr-v3-builder.timer
  tailscale serve --bg --https="$PORT" "$WWW"
  host="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{}})' || true)"
  echo "OK the Pi's source: https://${host:-<this machine>.<tailnet>.ts.net}:$PORT/ (first build within 3 minutes; log: $ROOT/builds.log)"
}

cmd_remove() {
  echo "PLAN disable and remove wherdr-v3-builder.timer and .service; tailscale serve --https=$PORT off (keeps $ROOT)"
  [ "${1:-}" = --yes ] || { echo "Dry run: nothing changed. Run again with --yes to apply."; return; }
  systemctl --user disable --now wherdr-v3-builder.timer || true
  rm -f "$UNITS/wherdr-v3-builder.timer" "$UNITS/wherdr-v3-builder.service"
  systemctl --user daemon-reload
  tailscale serve --https="$PORT" off || true
  echo "OK removed (builds kept in $ROOT)"
}

cmd_status() {
  echo "served:    $(cat "$WWW/COMMIT" 2>/dev/null || echo none)"
  echo "origin/$BRANCH: $(git -C "$SRC" rev-parse "origin/$BRANCH" 2>/dev/null || echo unknown)"
  [ ! -f "$ROOT/failed-commit" ] || echo "failed:    $(cat "$ROOT/failed-commit")"
  tail -n 5 "$ROOT/builds.log" 2>/dev/null || true
}

case "${1:-build}" in
  build) cmd_build ;;
  setup) shift; cmd_setup "$@" ;;
  remove) shift; cmd_remove "$@" ;;
  status) cmd_status ;;
  *) echo "usage: $0 [build|setup [--yes]|remove [--yes]|status]" >&2; exit 2 ;;
esac
