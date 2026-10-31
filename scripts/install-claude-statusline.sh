#!/bin/sh
# wherdr: installs Claude Code's invisible status line (quotas + account
# fingerprint) for the current user. Self-contained (the status line is included
# below): wherdr runs it as is on a machine ("Install" button) or
# hands it out to paste ("Copy command"). Safe to run again:
#  - writes the status line to ~/.claude/wherdr-statusline.sh (update);
#  - no `statusLine` in ~/.claude/settings.json: adds ours;
#  - another `statusLine` (command): chains it behind ours, its
#    output stays the same; backup copy settings.json.bak-wherdr.
# Quotas show up after the next exchange with a Claude.
set -e
dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$dir"
# ---- status line (prints nothing) ----
cat > "$dir/wherdr-statusline.sh.tmp" <<'WHERDR_STATUSLINE'
#!/bin/sh
# wherdr: Claude Code's invisible status line (prints nothing). It only keeps
# the account quotas (rate_limits, which Claude Code passes to its
# status line after each exchange) for the wherdr home screen, and an account
# fingerprint (truncated hash of its ID, never the ID or the email)
# to tell apart machines that do not use the same account. On API billing
# (API key, Console credits) Claude Code passes no rate_limits: once the session
# has had an API response (cost.total_api_duration_ms > 0), the snapshot is kept
# without them, and wherdr reads "API usage, no quota" for the machine.
# Installed by install-claude-statusline.sh (wherdr repository, README, "Quotas
# on the home screen"). Existing status line: passed as an argument, it receives the
# same data and its output is kept (sh wherdr-statusline.sh 'cmd').
d=$(cat)
case "$d" in
  *'"rate_limits"'*|*'"total_api_duration_ms"'*)
    dir="$HOME/.cache/herdr-web"
    mkdir -p "$dir"
    # Bind the fingerprint and timestamp to the payload in one atomic rename.
    # No fingerprint TTL: a login change must affect the very next reading.
    printf '%s' "$d" | python3 -c '
import hashlib, json, os, sys, tempfile, time
from pathlib import Path
cache = Path(sys.argv[1])
config = Path(os.environ.get("CLAUDE_CONFIG_DIR", os.environ["HOME"])) / ".claude.json"
try:
    account_id = json.loads(config.read_text()).get("oauthAccount", {}).get("accountUuid")
except (OSError, ValueError, AttributeError):
    account_id = None
account = hashlib.sha256(("wherdr:" + account_id).encode()).hexdigest()[:16] if isinstance(account_id, str) and account_id else None
status = json.load(sys.stdin)
if not isinstance(status, dict):
    sys.exit(0)
if "rate_limits" not in status:
    # Subscribers get rate_limits only after the first API response of a session:
    # without one yet, nothing is known. A session that already gave rate limits
    # stays a subscription (a window may drop out once it resets).
    api_ms = (status.get("cost") or {}).get("total_api_duration_ms")
    if not isinstance(api_ms, (int, float)) or api_ms <= 0:
        sys.exit(0)
    try:
        prev = json.loads((cache / "claude-status.json").read_text())
        if prev.get("rate_limits") is not None and prev.get("session_id") == status.get("session_id"):
            sys.exit(0)
    except (OSError, ValueError, AttributeError):
        pass
status["_wherdr"] = {"version": 1, "account": account, "at": int(time.time() * 1000)}
def atomic(name, text):
    fd, temp = tempfile.mkstemp(prefix=name + ".", dir=cache)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(temp, cache / name)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
# Compatibility for older readers; new readers use only the embedded account.
if account:
    atomic("claude-account", account + "\n")
else:
    (cache / "claude-account").unlink(missing_ok=True)
atomic("claude-status.json", json.dumps(status))
' "$dir" ;;
esac
if [ -n "$1" ]; then printf '%s' "$d" | sh -c "$1"; exit $?; fi
exit 0
WHERDR_STATUSLINE
chmod 755 "$dir/wherdr-statusline.sh.tmp"
mv "$dir/wherdr-statusline.sh.tmp" "$dir/wherdr-statusline.sh"
echo "status line written: $dir/wherdr-statusline.sh"
# ---- settings.json ----
[ -f "$dir/settings.json" ] || echo '{}' > "$dir/settings.json"
cp "$dir/settings.json" "$dir/settings.json.bak-wherdr"
python3 - "$dir/settings.json" "$dir/wherdr-statusline.sh" <<'WHERDR_PY'
import json, shlex, sys
path, script = sys.argv[1], sys.argv[2]
d = json.load(open(path))
ours = 'sh ' + shlex.quote(script)
cur = d.get('statusLine')
if isinstance(cur, dict) and 'wherdr-statusline.sh' in str(cur.get('command', '')):
    print('already installed:', cur['command'])
    sys.exit(0)
if cur is None:
    d['statusLine'] = {'type': 'command', 'command': ours}
    print('status line added:', ours)
elif isinstance(cur, dict) and cur.get('type') == 'command' and cur.get('command'):
    d['statusLine'] = {**cur, 'command': ours + ' ' + shlex.quote(cur['command'])}
    print('existing status line chained:', d['statusLine']['command'])
else:
    print('unknown statusLine, nothing changed:', json.dumps(cur), file=sys.stderr)
    sys.exit(1)
with open(path, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write('\n')
WHERDR_PY
