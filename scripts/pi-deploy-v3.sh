#!/usr/bin/env bash
# Installs the latest prebuilt v3 from a source folder (made by scripts/pi-v3-package.sh on
# another machine, served over HTTP on the tailnet, or a local folder) into a v3 install made
# by install-v3-beside-v2.sh. Never builds: it swaps <dir>/src/.output for the source's, restarts the v3 service, checks /api/health and
# puts the previous build back when the new one does not answer. Only touches <dir>/src/.output,
# <dir>/deploy and the v3 service: v2's install, service, port and data are never touched.
# Run by the <name>-deploy.timer that `install-v3-beside-v2.sh --auto-deploy --yes` sets up.
# The source holds wherdr-v3.tgz, wherdr-v3.tgz.sha256 and COMMIT (written last).
#   pi-deploy-v3.sh            deploy when the source's COMMIT is not the installed one
#   pi-deploy-v3.sh prepare    same, without restarting (the installer restarts itself)
#   pi-deploy-v3.sh rollback   put the previous build back and restart
#   pi-deploy-v3.sh status     installed commit, source commit, last log lines
# Settings (environment): WHERDR_V3_SOURCE (required: an http(s):// or file:// URL, or a
# folder path), WHERDR_V3_DIR (~/wherdr-v3), WHERDR_V3_SERVICE (wherdr-v3),
# WHERDR_V3_PORT (the manifest's, else 7684), WHERDR_V3_HEALTH_URL, WHERDR_HEAVY_LOCK (/tmp/wherdr-heavy.lock),
# WHERDR_V3_WAIT (seconds to wait for /api/health, 60).
set -euo pipefail

DIR="${WHERDR_V3_DIR:-$HOME/wherdr-v3}"
NAME="${WHERDR_V3_SERVICE:-wherdr-v3}"
manifest_port() { grep -o '"port": *"[0-9]*"' "$DIR/install-manifest.json" 2>/dev/null | grep -o '[0-9][0-9]*' | head -n 1 || true; }
PORT="${WHERDR_V3_PORT:-$(manifest_port)}"; PORT="${PORT:-7684}"
SOURCE="${WHERDR_V3_SOURCE:-}"
case "$SOURCE" in /*) SOURCE="file://$SOURCE" ;; esac
SOURCE="${SOURCE%/}"
HEALTH="${WHERDR_V3_HEALTH_URL:-http://127.0.0.1:$PORT/api/health}"
LOCK="${WHERDR_HEAVY_LOCK:-/tmp/wherdr-heavy.lock}"
WAIT="${WHERDR_V3_WAIT:-60}"
ASSET=wherdr-v3.tgz
STATE="$DIR/deploy"
OUT="$DIR/src/.output"

log() { mkdir -p "$STATE"; printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$STATE/deploy.log" >&2; }
die() { log "ERROR $*"; exit 1; }
fetch() { curl -fsSL --retry 2 --max-time 300 "$SOURCE/$1"; }
sha_ok() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
installed() { cat "$STATE/commit" 2>/dev/null || true; }
short() { [ -n "$1" ] && echo "${1:0:7}" || echo none; }

# True when /api/health answers with the version of <sha> (3.0.0-dev+<short sha>).
healthy() {
  local want="+${1:0:7}\"" i
  for ((i = 0; i < WAIT; i++)); do
    if curl -fsS --max-time 3 "$HEALTH" 2>/dev/null | grep -o '"version":"[^"]*"' | grep -qF "$want"; then return 0; fi
    sleep 1
  done
  return 1
}

# The lock stays with this script, never with a process the restart starts.
restart() { systemctl --user restart "$NAME.service" 9>&-; }

# Puts deploy/previous back as src/.output; the failed build goes away.
restore_previous() {
  [ -d "$STATE/previous/.output" ] || return 1
  rm -rf "$STATE/failed"; mkdir -p "$STATE/failed"
  [ ! -e "$OUT" ] || mv "$OUT" "$STATE/failed/.output"
  mv "$STATE/previous/.output" "$OUT"
  cp "$STATE/previous/COMMIT" "$STATE/commit" 2>/dev/null || rm -f "$STATE/commit"
  rm -rf "$STATE/previous" "$STATE/failed"
}

check_install() {
  [ -f "$DIR/install-manifest.json" ] && [ -d "$DIR/src" ] \
    || die "$DIR is not a v3 install made by install-v3-beside-v2.sh (no install-manifest.json or src/)"
  [[ "$SOURCE" =~ ^(https?|file):// ]] || die "WHERDR_V3_SOURCE must be an http(s):// URL or a folder (got '${WHERDR_V3_SOURCE:-}')"
}

cmd_deploy() {
  local mode="${1:-deploy}" remote again got old
  check_install
  remote="$(fetch COMMIT 2>/dev/null | tr -d '[:space:]')" || remote=""
  # No COMMIT: the build is being replaced (or unreachable); the next run retries.
  sha_ok "$remote" || exit 0
  [ "$remote" != "$(installed)" ] || exit 0
  # A build that failed its health check is not retried; the next push replaces it.
  [ "$remote" != "$(cat "$STATE/failed-commit" 2>/dev/null)" ] || exit 0

  # The heavy steps wait for other heavy work on this machine (builds, tests).
  exec 9>>"$LOCK"
  flock -w 900 9 || die "could not take $LOCK in 15 minutes"
  [ "$remote" != "$(installed)" ] || exit 0

  mkdir -p "$STATE"
  tmp="$(mktemp -d "$STATE/download.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT  # global: the trap runs after this function returns
  fetch "$ASSET" > "$tmp/$ASSET" || die "could not download $ASSET"
  fetch "$ASSET.sha256" > "$tmp/$ASSET.sha256" || die "could not download $ASSET.sha256"
  (cd "$tmp" && sha256sum -c --quiet "$ASSET.sha256" >/dev/null 2>&1) || die "checksum mismatch for $ASSET of $(short "$remote")"
  # Published while downloading: the next run takes the new one.
  again="$(fetch COMMIT 2>/dev/null | tr -d '[:space:]')" || again=""
  if [ "$again" != "$remote" ]; then log "SKIP the source moved during the download; next run"; exit 0; fi
  mkdir "$tmp/x"
  tar -xzf "$tmp/$ASSET" -C "$tmp/x" || die "could not extract $ASSET"
  got="$(tr -d '[:space:]' < "$tmp/x/COMMIT" 2>/dev/null || true)"
  [ "$got" = "$remote" ] || die "$ASSET holds $(short "$got"), COMMIT says $(short "$remote")"
  [ -f "$tmp/x/.output/server/index.mjs" ] || die "$ASSET has no .output/server/index.mjs"

  # Swap (renames inside <dir>: same file system). The running build is kept as previous.
  old="$(installed)"
  rm -rf "$STATE/previous"
  if [ -e "$OUT" ]; then
    mkdir -p "$STATE/previous"
    mv "$OUT" "$STATE/previous/.output"
    [ -z "$old" ] || printf '%s\n' "$old" > "$STATE/previous/COMMIT"
  fi
  mv "$tmp/x/.output" "$OUT"
  printf '%s\n' "$remote" > "$STATE/commit"
  rm -f "$STATE/failed-commit"

  if [ "$mode" = prepare ]; then log "OK installed $(short "$remote") (was $(short "$old")), not restarted"; return; fi
  restart || true
  if healthy "$remote"; then log "OK deployed $(short "$remote") (was $(short "$old"))"; return; fi

  printf '%s\n' "$remote" > "$STATE/failed-commit"
  log "ERROR $(short "$remote") does not answer on $HEALTH with its version (journalctl --user -u $NAME)"
  if ! restore_previous; then die "no previous build to roll back to"; fi
  restart || true
  if [ -z "$old" ] || healthy "$old"; then log "ROLLBACK back to $(short "$old")"; else log "ERROR rolled back to $(short "$old"), which does not answer either"; fi
  exit 1
}

cmd_rollback() {
  local from
  check_install
  exec 9>>"$LOCK"
  flock -w 900 9 || die "could not take $LOCK in 15 minutes"
  from="$(installed)"
  restore_previous || die "no previous build in $STATE/previous"
  # Not redeployed by the timer until a newer commit is published.
  [ -z "$from" ] || printf '%s\n' "$from" > "$STATE/failed-commit"
  restart || true
  log "ROLLBACK by hand from $(short "$from") to $(short "$(installed)")"
}

cmd_status() {
  echo "installed: $(installed || true)"
  echo "source:    $(fetch COMMIT 2>/dev/null | tr -d '[:space:]' || echo unreachable)"
  [ ! -f "$STATE/failed-commit" ] || echo "skipped (failed): $(cat "$STATE/failed-commit")"
  [ ! -d "$STATE/previous/.output" ] || echo "previous:  $(cat "$STATE/previous/COMMIT" 2>/dev/null || echo unknown)"
  tail -n 5 "$STATE/deploy.log" 2>/dev/null || true
}

case "${1:-deploy}" in
  deploy) cmd_deploy ;;
  prepare) cmd_deploy prepare ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  *) echo "usage: $0 [deploy|prepare|rollback|status]" >&2; exit 2 ;;
esac
