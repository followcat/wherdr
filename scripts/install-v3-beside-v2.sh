#!/usr/bin/env sh
# Installs wherdr v3 beside a running wherdr v2 and imports what v3 can use.
# Without --yes it only prints the plan. --help for the options; see docs/migrate-from-v2.md.
# Exit codes: 0 done or plan printed, 2 bad usage, 3 missing prerequisite, 4 conflict,
# 5 a step failed, 6 installed but something is left for you (NEXT lines).
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR missing-node: Node.js 22 or newer is required (https://nodejs.org)" >&2; exit 3
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "ERROR missing-node: Node.js 22 or newer is required (found $(node --version))" >&2; exit 3
fi
exec node "$here/install-v3-beside-v2.mjs" "$@"
