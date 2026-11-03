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

def clip(v, n):
    return v[:n] if isinstance(v, str) else v

# The sidecar holds prompts and tool output: bound what lands in it (replies
# at chat-item size, results and inputs much smaller — the tail only needs
# their heads), and keep it readable by the owner only.
ev['prompt'] = clip(ev.get('prompt'), 20000)
ev['last_assistant_message'] = clip(ev.get('last_assistant_message'), 20000)
ev['tool_response'] = clip(ev.get('tool_response'), 4000)
ti = ev.get('tool_input')
if isinstance(ti, dict):
    ev['tool_input'] = {k: clip(v, 1000) for k, v in ti.items()}
try:
    # Always ~/.cache: the reader builds this path from the machine's home
    # and cannot know its XDG_CACHE_HOME.
    d = os.path.join(os.path.expanduser('~'), '.cache', 'herdr-web', 'devin-live')
    os.makedirs(d, exist_ok=True)
    f = os.path.join(d, sid + '.jsonl')
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a') as fh:
        fh.write(json.dumps({'ts': int(time.time() * 1000), 'ev': ev}, separators=(',', ':')) + '\\n')
    os.chmod(f, 0o600)
    if os.path.getsize(f) > 131072:
        with open(f, 'rb') as fh:
            fh.seek(-65536, os.SEEK_END)
            lines = fh.read().splitlines()[-400:]
        fd = os.open(f + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as fh:
            fh.write(b'\\n'.join(lines) + b'\\n')
        os.replace(f + '.tmp', f)
except Exception:
    pass
sys.exit(0)
`

// Idempotent install run on the Devin machine over the machine's shell
// channel: drops the hook script and merges one entry into each event list
// of ~/.config/devin/config.json (existing entries — herdr's own hook — are
// kept). PostCompaction is not registered: the tail ignores it. Devin
// snapshots hook configuration at session start, so sessions already
// running report nothing until they restart; that is expected.
const INSTALL_SCRIPT = `set -e
command -v python3 >/dev/null 2>&1 || { echo no-python3; exit 1; }
cfgd="$HOME/.config/devin"
mkdir -p "$cfgd" "$HOME/.cache/herdr-web/devin-live"
cat > "$cfgd/wherdr-devin-live.py" <<'WHERDR_HOOK_EOF'
${HOOK_PY}
WHERDR_HOOK_EOF
chmod 755 "$cfgd/wherdr-devin-live.py"
find "$HOME/.cache/herdr-web/devin-live" -name '*.jsonl' -mtime +7 -delete 2>/dev/null || true
python3 - <<'WHERDR_CFG_EOF'
import json, os, shutil, sys
cfgd = os.path.expanduser('~/.config/devin')
p = os.path.join(cfgd, 'config.json')
d = {}
if os.path.exists(p):
    try:
        with open(p) as fh:
            d = json.load(fh)
    except Exception:
        d = None
    # An existing file that does not hold a JSON object (a comment, a
    # trailing comma, a half-written config) is left exactly as it is:
    # rewriting it would drop the user's settings and herdr's own hooks.
    if not isinstance(d, dict):
        print('bad-config')
        sys.exit(1)
hooks = d.setdefault('hooks', {})
if not isinstance(hooks, dict):
    print('bad-config')
    sys.exit(1)
entry = {'type': 'command', 'command': "python3 '%s/wherdr-devin-live.py'" % cfgd, 'timeout': 5}
changed = False
for ev in ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']:
    arr = hooks.setdefault(ev, [])
    if not isinstance(arr, list):
        arr = hooks[ev] = []
    if any('${HOOK_MARKER}' in (h.get('command') or '') for e in arr if isinstance(e, dict) for h in e.get('hooks', [])):
        continue
    arr.append({'hooks': [dict(entry)]})
    changed = True
if changed:
    exists = os.path.exists(p)
    if exists:
        shutil.copy2(p, p + '.wherdr-bak')
    tmp = p + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(d, fh, indent=2)
    # The replacement is atomic and keeps the file's mode; a config we
    # create starts private, like the events the hook writes.
    if exists:
        shutil.copymode(p, tmp)
    else:
        os.chmod(tmp, 0o600)
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
// PostToolUse with its pending PreToolUse by tool_use_id when the event
// carries one, else by per-tool-name order.
export function parseLiveEvents(raw: string, afterTs: number): ChatItem[] {
  const items: ChatItem[] = []
  const pending = new Map<string, { item: ChatItem, id: string | null }[]>()
  const pendingById = new Map<string, ChatItem>()
  const iso = (ms: number) => new Date(ms).toISOString()
  const useId = (ev: Record<string, unknown>) => typeof ev.tool_use_id === 'string' && ev.tool_use_id ? ev.tool_use_id : null
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
      const id = useId(ev)
      const q = pending.get(name) || []
      q.push({ item: t, id })
      pending.set(name, q)
      if (id) pendingById.set(id, t)
    } else if (kind === 'PostToolUse') {
      const name = String(ev.tool_name || 'Tool')
      const id = useId(ev)
      // A result with an id claims its own call even out of order; without
      // one, the oldest waiting call of the same tool name, as before.
      let t = id ? pendingById.get(id) ?? null : null
      if (t) {
        pendingById.delete(id!)
        const q = pending.get(name)
        const at = q ? q.findIndex(e => e.item === t) : -1
        if (at >= 0) q!.splice(at, 1)
      } else {
        const e = pending.get(name)?.shift()
        if (e) {
          t = e.item
          if (e.id) pendingById.delete(e.id)
        }
      }
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

// A Stop event ends its turn, and Devin rewrites the ATIF transcript at
// about that moment — a little before or after the hook runs, so the file's
// mtime gets a slack window. Once the transcript has caught up to a Stop,
// everything up to it is ATIF's own: cutting by the last step's clock alone
// resurfaces the turn's events, the Stop's copy of the final reply first
// (the hook fires after the last step was generated, so its ts is newer).
// A Stop ATIF has not reached yet means that turn is still live.
const LIVE_STOP_SLACK_MS = 10 * 1000

function exportedThrough(raw: string, atifMtimeMs: number): number {
  let through = 0
  for (const line of raw.split('\n')) {
    if (!line.includes('"Stop"')) continue
    let rec: { ts?: number, ev?: Record<string, unknown> }
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.ev?.hook_event_name !== 'Stop' || typeof rec.ts !== 'number') continue
    if (atifMtimeMs >= rec.ts - LIVE_STOP_SLACK_MS && rec.ts > through) through = rec.ts
  }
  return through
}

// Reads the sidecar's tail and returns the live items of the turn ATIF has
// not exported yet: events newer than its last step (`afterTs`) and past the
// newest Stop the transcript's mtime covers. The file lives on the Devin
// machine, so reads go through its MachineFs.
export async function readDevinLive(fs: MachineFs, file: string, size: number, afterTs: number, atifMtimeMs = 0): Promise<ChatItem[]> {
  const start = Math.max(0, size - LIVE_TAIL_BYTES)
  const buf = await fs.read(file, start, size - start)
  const raw = buf.toString('utf8')
  return parseLiveEvents(raw, Math.max(afterTs, exportedThrough(raw, atifMtimeMs)))
}
