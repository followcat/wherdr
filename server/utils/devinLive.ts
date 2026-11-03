// Devin's ATIF transcript is written when a turn ends, so an in-progress
// turn — prompt included — is invisible until then. Devin's documented
// lifecycle hooks fire in real time (the same mechanism herdr's own
// integration uses to report pane sessions), so we install one small hook on
// each Devin machine: it appends hook events to a per-session JSONL sidecar,
// and the conversation tail appends any events newer than the transcript's
// last step. ATIF stays the only transcript of record; the sidecar is a
// transient overlay that disappears from the view as soon as ATIF lands.
import type { ChatItem } from '../../shared/types'
import type { MachineFs, ShellExec } from './fsx'

const LIVE_TAIL_BYTES = 64 * 1024
const LIVE_MAX_ITEMS = 40
const INSTALL_RETRY_MS = 10 * 60 * 1000
const MAX_TEXT = 20000
export const HOOK_MARKER = 'wherdr-devin-live'

export function livePath(home: string, session: string): string | null {
  if (!session || /[/\\]|\0/.test(session)) return null
  return `${home}/.cache/herdr-web/devin-live/${session}.jsonl`
}

// Runs under `python3 <path>` inside each Devin lifecycle hook. Reads the
// event JSON on stdin, appends `{ts, ev}` to the session's sidecar, trims it.
// Must always exit 0 quickly — hooks sit on the agent's critical path.
const HOOK_PY = `#!/usr/bin/env python3
# ${HOOK_MARKER}: Devin lifecycle hook -> JSONL sidecar for wherdr's live tail.
import json, os, sys, time

try:
    ev = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sid = str(ev.get('session_id') or '')
if not sid or not all(c.isalnum() or c in '-_' for c in sid):
    sys.exit(0)
try:
    root = os.environ.get('XDG_CACHE_HOME') or os.path.join(os.path.expanduser('~'), '.cache')
    d = os.path.join(root, 'herdr-web', 'devin-live')
    os.makedirs(d, exist_ok=True)
    f = os.path.join(d, sid + '.jsonl')
    with open(f, 'a') as fh:
        fh.write(json.dumps({'ts': int(time.time() * 1000), 'ev': ev}, separators=(',', ':')) + '\\n')
    if os.path.getsize(f) > 131072:
        with open(f, 'rb') as fh:
            fh.seek(-65536, os.SEEK_END)
            lines = fh.read().splitlines()[-400:]
        with open(f + '.tmp', 'wb') as fh:
            fh.write(b'\\n'.join(lines) + b'\\n')
        os.replace(f + '.tmp', f)
except Exception:
    pass
sys.exit(0)
`

// Idempotent install run on the Devin machine over the machine's shell
// channel: drops the hook script and merges one entry into each event list
// of ~/.config/devin/config.json (existing entries — herdr's own hook — are
// kept). Devin snapshots hook configuration at session start, so sessions
// already running report nothing until they restart; that is expected.
const INSTALL_SCRIPT = `set -e
command -v python3 >/dev/null 2>&1 || { echo no-python3; exit 1; }
cfgd="$HOME/.config/devin"
mkdir -p "$cfgd" "$HOME/.cache/herdr-web/devin-live"
cat > "$cfgd/wherdr-devin-live.py" <<'WHERDR_HOOK_EOF'
${HOOK_PY}
WHERDR_HOOK_EOF
chmod 755 "$cfgd/wherdr-devin-live.py"
python3 - <<'WHERDR_CFG_EOF'
import json, os, shutil
cfgd = os.path.expanduser('~/.config/devin')
p = os.path.join(cfgd, 'config.json')
try:
    d = json.load(open(p))
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
hooks = d.setdefault('hooks', {})
entry = {'type': 'command', 'command': "python3 '%s/wherdr-devin-live.py'" % cfgd, 'timeout': 5}
changed = False
for ev in ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PostCompaction']:
    arr = hooks.setdefault(ev, [])
    if not isinstance(arr, list):
        arr = hooks[ev] = []
    if any('${HOOK_MARKER}' in (h.get('command') or '') for e in arr if isinstance(e, dict) for h in e.get('hooks', [])):
        continue
    arr.append({'hooks': [dict(entry)]})
    changed = True
if changed:
    if os.path.exists(p):
        shutil.copy2(p, p + '.wherdr-bak')
    tmp = p + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(d, fh, indent=2)
    os.replace(tmp, p)
WHERDR_CFG_EOF
echo installed
`

// At most one install attempt per machine filesystem per interval; a
// successful one is not repeated while this filesystem object lives (a
// reconnect gets a fresh object and re-checks cheaply).
const installAt = new WeakMap<object, number>()

export async function ensureDevinLive(fs: MachineFs, exec: ShellExec | undefined, now: () => number = Date.now): Promise<void> {
  if (!exec) return
  const at = installAt.get(fs)
  if (at !== undefined && now() - at < INSTALL_RETRY_MS) return
  installAt.set(fs, now())
  try {
    const r = await exec(INSTALL_SCRIPT, [], { timeoutMs: 20000 })
    if (r.code === 0) installAt.set(fs, Number.MAX_SAFE_INTEGER / 4)
  } catch { /* retry after the interval */ }
}

const clip = (s: unknown, max = MAX_TEXT) => typeof s === 'string' ? s.slice(0, max) : ''
const asText = (v: unknown) => typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)

// Maps hook events newer than `afterTs` to chat items, pairing each
// PostToolUse with its pending PreToolUse (same tool name, in order).
export function parseLiveEvents(raw: string, afterTs: number): ChatItem[] {
  const items: ChatItem[] = []
  const pending = new Map<string, ChatItem[]>()
  const iso = (ms: number) => new Date(ms).toISOString()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec: { ts?: number, ev?: Record<string, unknown> }
    try { rec = JSON.parse(line) } catch { continue }
    const ts = typeof rec.ts === 'number' ? rec.ts : 0
    const ev = rec.ev
    if (!ev || typeof ev !== 'object' || ts <= afterTs) continue
    const kind = String(ev.hook_event_name || '')
    if (kind === 'UserPromptSubmit') {
      const text = clip(ev.prompt)
      if (text) items.push({ role: 'user', text, ts: iso(ts), live: true })
    } else if (kind === 'PreToolUse') {
      const name = String(ev.tool_name || 'Tool')
      const input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input as Record<string, unknown> : {}
      const summary = input.command || input.file_path || input.path || input.query || input.pattern || name
      const t: ChatItem = { role: 'tool', name, text: clip(String(summary), 300), ts: iso(ts), live: true, toolStatus: 'running' }
      items.push(t)
      const q = pending.get(name) || []
      q.push(t)
      pending.set(name, q)
    } else if (kind === 'PostToolUse') {
      const name = String(ev.tool_name || 'Tool')
      const q = pending.get(name)
      const t = q && q.length ? q.shift()! : null
      const out = clip(asText(ev.tool_response))
      if (t) {
        t.toolStatus = 'completed'
        if (out) t.out = out
      } else {
        items.push({ role: 'tool', name, text: '', ts: iso(ts), live: true, toolStatus: 'completed', ...(out ? { out } : {}) })
      }
    } else if (kind === 'Stop') {
      const text = clip(ev.last_assistant_message)
      if (text) items.push({ role: 'assistant', text, ts: iso(ts), live: true })
    }
  }
  return items.slice(-LIVE_MAX_ITEMS)
}

// Reads the sidecar's tail and returns the live items newer than `afterTs`;
// the file lives on the Devin machine, so reads go through its MachineFs.
export async function readDevinLive(fs: MachineFs, file: string, size: number, afterTs: number): Promise<ChatItem[]> {
  const start = Math.max(0, size - LIVE_TAIL_BYTES)
  const buf = await fs.read(file, start, size - start)
  return parseLiveEvents(buf.toString('utf8'), afterTs)
}
