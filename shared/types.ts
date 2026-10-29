// Types shared between the server (Nitro) and the app (Vue).
import type { TabLayout } from './layout'
import type { CodexStatus } from './codexStatus'
import type { MaxSessionDays } from './sessionLimit'
import type { UsageLimit } from './usageLimit'
import type { ScreenInteraction } from './interactiveScreen'

export type AgentStatus = 'working' | 'blocked' | 'done' | 'idle' | 'unknown'

// `checked`: box of a multiple-choice list (Choices.multi), checked on screen.
// `free`: free-text answer (omp's "Other"): chosen with a text, which the server
// types into the field the option opens (server/utils/freeAnswer.ts).
// `n`: number shown before the option (numbered lists).
export interface ChoiceOption { label: string, hint: string | null, checked?: boolean, free?: boolean, n?: number }
// What a permission request allows: the tool, its description, and the
// full command (or tool input), or the file touched.
export interface PromptDetail {
  tool: string
  description?: string
  command?: string
  file?: string
  added?: number
  removed?: number
  // Command cut on the server side (very long): the app says so.
  truncated?: boolean
}
// `multi`: checkboxes (omp); a choice checks or unchecks, Enter moves on.
// `typing`: omp's free-text answer field is open (single option: `free`).
// `tabs`: tabs of omp's multi-question "Ask" box (the last one is Submit),
// `tab` the one shown; ←/→ move between them.
export interface Choices { identity?: string, unavailable?: boolean, question: string | null, cursor: number, options: ChoiceOption[], kind?: 'self-update', detail?: PromptDetail, multi?: boolean, typing?: boolean, tabs?: string[], tab?: number }

// Waiting screen of an agent (Codex at startup: hooks, folder trust,
// login…), see server/utils/waitScreen.ts. `other`: unrecognized screen,
// only shown while there is no conversation.
export type WaitKind = 'hooks' | 'trust' | 'login' | 'update' | 'other'
// Key from the screen's legend ("t trust all" → { key: 't', label: 'trust all' }).
export interface WaitAction { key: string, label: string }
export interface WaitScreen { identity?: string, unavailable?: boolean, kind: WaitKind, title: string | null, lines: string[], actions: WaitAction[] }

// Claude Code's full-screen interactive menu (/resume, /model, /mcp…), see
// shared/menuScreen.ts. `header`: group header, not an entry; `search`:
// text of the search field (null: no search); `more`: "19 more below".
export interface MenuEntry { identity?: string, label: string, hint: string | null, header?: boolean, cursor?: boolean }
export interface InteractiveMenu {
  identity?: string
  unavailable?: boolean
  title: string | null
  lines: string[]
  items: MenuEntry[]
  cursor: number | null
  search: string | null
  actions: WaitAction[]
  more: string | null
}

// state: held until a menu closes (server side), or failed to send.
// reason 'busy': held or not sent because the agent's input field held other text.
// reason 'turn': held until the agent's turn ends (typing it during the turn failed).
// 'no_input': not sent because the input field was not found on a screen
// showing no recognized menu (see queued.ts NO_INPUT_MS).
// `pasted`: the long pasted texts its text holds (see server/utils/pastes.ts).
// `back`: no agent will take it (see server/utils/queued.ts giveBackHeld): the
// app puts its text back into the message field.
export interface QueuedMessage { inputText?: string, id: string, text: string, at?: number, state?: 'held' | 'failed', reason?: 'busy' | 'no_input' | 'turn' | 'lost' | 'unseen', pasted?: string[], back?: boolean }

// Claude Code's screen while working (see server/utils/claudeScreen.ts): the
// "!" command running, the last message sent, the messages
// still in its queue. The transcript only has the "!" command at the end.
export interface ShellRun {
  command: string
  // Last output lines shown (Claude only shows a few).
  lines: string[]
  // Hidden lines above ("+12 lines").
  hidden: number
  // Start of the execution (ms), deduced from the "(37s)" counter (omp: first seen).
  since: number | null
  // omp's "$ code" (Python) rather than a "!" shell command.
  python?: boolean
}
export interface ClaudeScreen { sendNow?: boolean, shell: ShellRun | null, sent: string | null, queued: string[] }

export interface Workspace {
  id: string
  // Remote machine (short key); missing for the local machine.
  machine?: string
  label: string
  number: number
  status: string | null
  worktree: boolean
  // Git repository of the workspace (Herdr: `worktree.repo_key` / `repo_name`), shared
  // by the main checkout and its worktrees; missing outside a repository.
  repo?: string
  path?: string // Herdr checkout path, when available
  repoName?: string
  branch?: string
}

// Tab of a Herdr workspace and its layout (real splits, see shared/layout.ts).
export interface Tab {
  // w1:t1 (local) ou <machine>~w1:t1 (distant).
  id: string
  machine?: string
  workspace: string
  label: string
  number: number
  // Missing if Herdr did not give it: the app then stacks the panes.
  layout: TabLayout | null
}

export interface Pane {
  // w1:p1 (local) ou <machine>~w1:p1 (distant, see shared/ids.ts).
  id: string
  // Remote machine (short key); missing for the local machine.
  machine?: string
  workspace: string
  tab: string
  tabLabel: string | null
  agent: string | null
  name: string | null
  label: string | null
  // Agent name shown by Herdr (`display_agent`), if it says more than the agent kind.
  displayAgent?: string
  // Pane without an agent: foreground command ("pnpm dev"), missing at the shell prompt.
  command?: string
  status: AgentStatus | null
  title: string | null
  cwd: string | null
  agentSession: string | null
  bornAt?: number
  // Number of the agent's last state change (Herdr's `state_change_seq`,
  // increasing on a machine): "recent" sort of Ready.
  stateSeq?: number
  pendingPrompt?: boolean
  queued?: QueuedMessage[]
  prompt?: Choices
  // Live wait in this pane, independent of the account-wide quota gauges.
  usageLimit?: UsageLimit
  // Conservative presentation of the current terminal screen, not a command.
  interaction?: ScreenInteraction
  screen?: WaitScreen
  // Menu interactif ouvert (agent au repos) : il remplace `prompt` et `screen`.
  menu?: InteractiveMenu
  // A menu or panel no card shows hides the agent's input field while
  // messages wait for it (see server/utils/queued.ts lookForLeftMenu).
  menuLeftOpen?: boolean
  preview?: string
  model?: ModelInfo
  // Claude working, conversation shown: verb of its activity line ("Orbiting").
  activity?: string
  // Claude working, conversation shown: what its screen shows.
  claudeScreen?: ClaudeScreen
  // Claude Code status near the input field ("✔ Update installed · Restart to update").
  claudeNotice?: string
  // Restart requested from wherdr (see server/utils/restart.ts): the agent
  // quits then comes back, the pane is briefly without an agent. `update`:
  // Codex update typed into its terminal between the two (the command).
  restart?: { phase: 'stopping' | 'updating' | 'starting' | 'failed', agent: string, error?: string, update?: string }
  stopped?: { reason: 'update' }
  // Codex just left this pane and its screen is not checked yet (update or
  // plain exit?): a shell for a few seconds, where a message must not be typed.
  leaving?: boolean
  // Grayed-out next-message suggestion in Claude Code's field (Tab accepts it).
  claudeSuggestion?: string
  // Codex shown: update available and weekly-limit warning (see shared/codexStatus.ts).
  codexStatus?: CodexStatus
  // Codex resting, conversation shown: first line of the text left in its
  // input field (see server/utils/state.ts, refreshCodexField).
  codexField?: string
  // omp shown: its status line (model, folder, branch) and its gauges (context, quotas).
  ompStatus?: OmpStatus
  // omp working, conversation shown: the running step ("Finding Fixed section",
  // null before the first tool) and when the turn started (ms, null if unknown).
  ompActivity?: OmpActivity
  // omp shown: the "!" / "$" command the user is running (omp stays idle meanwhile).
  ompShell?: ShellRun
}
export interface OmpStatus { line: string, meters: string | null }
export interface OmpActivity { step: string | null, since: number | null }

export interface ChangeLine { kind: 'add' | 'del' | 'context' | 'hunk' | 'meta', text: string }
export interface ChangeFile {
  path: string
  previousPath?: string
  status: string
  added: number | null
  deleted: number | null
  lines: ChangeLine[]
  binary: boolean
  truncated: boolean
  summary?: string
}
export interface ChangeSet { files: ChangeFile[], truncated: boolean, count: number }
export interface ChangesResponse {
  git: boolean
  root?: string
  branch?: string
  working?: ChangeSet
  committed?: ChangeSet | null
  comparison?: string | null
  commits?: number | null
}

// Model of an agent: readable label ("Opus 5.5", "GPT-6-Sol") and raw
// identifier when known (`claude-opus-5-5`, `gpt-6-sol`).
export interface ModelInfo {
  id: string | null
  label: string
  effort?: string | null
  // omp "auto": the level it resolved to for the current turn ("low"…).
  effortResolved?: string | null
  at?: string | null
}
// Option of an agent's /model menu.
export interface ModelOption { label: string, hint: string | null, current?: boolean, isDefault?: boolean }
export interface ModelList { agent: string, options: ModelOption[], at: number }
export interface EffortList { levels: string[], current: string | null }

// A machine (local, or Herdr SSH profile) and the state of its connection.
export interface MachineInfo {
  key: string // '' = local
  baseKey?: string // original machine for a named session
  session?: string
  label: string
  local: boolean
  status: 'online' | 'connecting' | 'offline'
  error: string | null
  target?: string
  version?: string
  os?: string // `uname -s`: 'Darwin' (macOS), 'Linux'…
}

export interface NamedSession { name: string, running: boolean, key: string }

export interface HerdrState {
  ok: boolean
  // false: server just (re)started, state still partial (shared/stateReady.ts).
  ready?: boolean
  error?: string
  version?: string
  session?: string
  workspaces: Workspace[]
  panes: Pane[]
  // Tabs and layouts (missing from an old state kept offline).
  tabs?: Tab[]
  // Only present when there are remote machines.
  machines?: MachineInfo[]
}

// 'bash': Claude Code "!" command (bash mode), 'cmd': local "/" command.
// 'notice': note shown by the agent outside its replies (omp advisor,
// finished background task, IRC message…); `name` gives its kind.
export type ChatRole = 'user' | 'assistant' | 'thinking' | 'tool' | 'cmd' | 'bash' | 'system' | 'notice' | 'job'
export interface ChatItem {
  role: ChatRole
  text: string
  ts: string | null
  name?: string
  // Output of a 'bash' or 'cmd' command (stdout / stderr).
  out?: string
  err?: string
  images?: number
  ref?: string
  // User message: long pasted texts it holds (Claude's <pasted_content>
  // blocks, texts pasted into wherdr's field on any device), still part of
  // `text`; shown as cards (shared/pastedText.ts).
  pasted?: string[]
  // Index of the item's first image on its line (`i` of /api/chat/image),
  // when the line holds other images before it (Claude tool results).
  imageAt?: number
  // sha256 of each image's bytes (omp: its blob hash), to spot an image
  // already shown higher up (see shared/imageDupes.ts).
  hashes?: string[]
  error?: boolean
  // omp reasoning and completed background jobs, read from its transcript.
  ms?: number
  job?: { id: string, tool: string, out: string }
  // omp tools: shown the way omp's terminal shows them (see server/utils/ompTools.ts).
  omp?: OmpToolView
}
// An omp tool call: omp's own title ("Bash", "Grep"…), its target (command,
// path with its line range, pattern, query), counts, wall time, and the end
// of its output (`outLines`: lines in the whole output, `diff`: an edit's diff).
export interface OmpToolView {
  title: string
  target?: string
  intent?: string
  scope?: string
  matches?: number
  files?: number
  added?: number
  removed?: number
  job?: string
  exit?: number
  cancelled?: boolean
  ms?: number
  out?: string
  outLines?: number
  diff?: boolean
}
// `images`: photos of the entry ("[Image #1]" tags, removed from `text`).
// `sent`: the message as wherdr sent it (photo and file paths included), when
// the entry is one of wherdr's messages with photos (see server/utils/sentHistory.ts).
export interface ClaudeQueueEntry { text: string, ts: string | null, images?: number, sent?: string }

export interface ChatResponse {
  available: boolean
  // 'no_integration': not found, and Herdr's integration of this agent is
  // missing on its machine (see shared/integrations.ts).
  reason?: 'unsupported' | 'not_found' | 'no_integration'
  // With 'no_integration': the agent kind, the command to run, and on which
  // machine (null: this one, or the only one).
  integration?: { agent: string, command: string, machine: string | null }
  file?: string
  session?: string
  guessed?: boolean
  token?: string
  unchanged?: boolean
  older?: boolean
  items?: ChatItem[]
  // Incremental re-read (server/utils/chatDelta.ts): the client keeps its
  // first `keep` items and `items` replace the rest. Absent: `items` is the
  // whole bottom of the conversation.
  keep?: number
  // Source cursor: JSONL byte offset, or Devin main-chain node id + 1.
  // Zero means the beginning; callers pass it back without interpreting it.
  start?: number
  // The transcript was rewritten above the client's cursor (same size or
  // shorter): the reply is a fresh bottom, the client starts again from it.
  rewritten?: boolean
  queue?: ClaudeQueueEntry[]
  // Claude: entries of the most recent window pulled back out of its queue
  // into the input field and not queued again (see server/utils/queued.ts checkSent).
  popped?: ClaudeQueueEntry[]
  model?: ModelInfo | null
}

export interface ConversationHit {
  pane: string
  agent: string
  title: string
  role: ChatRole
  text: string
  excerpt: string
  ts: string | null
  offset: number
}
export interface ConversationSearchResponse { hits: ConversationHit[], limited: boolean }

// Herdr theme (~/.config/herdr/config.toml, [theme] section), for "Follow Herdr".
export interface HerdrThemeConfig {
  name: string | null
  autoSwitch: boolean
  darkName: string | null
  lightName: string | null
  custom: Record<string, string>
  customLight: Record<string, string>
  customDark: Record<string, string>
}

// Machine offered in the "New" sheet: home folder and recent ones.
export interface MachineConfig { key: string, label: string, local: boolean, home: string, dirs: string[], online: boolean, kinds: string[] }

export interface AppConfig {
  hostLabel?: string
  machines?: MachineConfig[]
  herdrTheme?: HerdrThemeConfig | null
  kinds: string[]
  home: string
  os?: string // local machine, `uname -s` names
  dirs: string[]
  push: { enabled: boolean, key: string | null, devices: number }
  // WHERDR_TRUSTED_NETWORKS=any: wherdr accepts every network (warning banner).
  openNetwork?: boolean
}

export interface DirEntry { name: string, path: string, git: boolean }
// `denied`: the folder exists but its content cannot be listed (`dirs` empty);
// `remote`: listed over SSH (the macOS fix differs from the local one).
export interface DirListing { path: string, parent: string | null, home: string, dirs: DirEntry[], denied?: 'macos' | 'permission', remote?: boolean }

export interface AuthStatus {
  hostLabel?: string
  enabled: boolean
  unlocked: boolean
  expiresAt?: number | null
  // Server clock when answering (the client converts expiresAt to its own clock).
  now?: number
  // Unlocked: when the maximum duration since the passkey unlock runs out (the
  // next opening after it asks for the passkey again).
  deadline?: number
  // Server setting (lock enabled only).
  maxSessionDays?: MaxSessionDays
  devices: { name: string, createdAt: string, lastUsed: string | null }[]
}

// "/" command of an agent (input field menu).
export interface SlashCommand {
  name: string // without the slash
  desc: string
  hint?: string
  source: 'builtin' | 'skill' | 'command'
}

// Usage quotas of an account (Claude or Codex): 5-hour window and week.
export interface QuotaWindow {
  used: number // % used
  resetsAt: number | null // ms
  minutes: number // window duration
  fresh?: boolean // window that just restarted, missing from the reading: nothing used
}
export interface Quota { five: QuotaWindow | null, week: QuotaWindow | null, at: number }
// Quotas of an account and machines using it (key '' = local, displayed name).
export interface AccountQuota extends Quota { machines: { key: string, label: string }[] }
export interface Quotas {
  // Most recent reading, across all machines.
  claude: Quota | null
  codex: Quota | null
  // Only present when the online machines do not use the same account
  // Claude: one block per account (at least two).
  claudeAccounts?: AccountQuota[]
  // Same for Codex (fingerprint taken from its conversations).
  codexAccounts?: AccountQuota[]
  // Online machines where wherdr's status line is not set up
  // (missing: all configured).
  claudeSetup?: ClaudeSetup[]
}
// Claude quota status line of each machine read: `ok` = set up, `pending` =
// installed, waiting for the next exchange with a Claude, `outdated` = quotas
// read but from an older status line (update offered), `missing` = to install.
// `installable`: the server can install it itself (otherwise, a command to copy).
// `dismissed`: the suggestion was declined or skipped (home menu, setup guide);
// Settings still offers it.
export type ClaudeSetupState = 'ok' | 'pending' | 'outdated' | 'missing'
export interface ClaudeSetup { key: string, state: ClaudeSetupState, installable: boolean, dismissed?: boolean }

// Git worktree linked to a repository (Herdr), for the cleanup list.
export interface WorktreeInfo {
  machine: string // machine key ('' = local)
  repo: string
  repoRoot: string
  path: string
  branch: string | null
  workspace: string | null // open workspace (app ID), otherwise closed
  agents: number
  panes: number
  prunable: boolean // folder gone
}

// Action of a Herdr plugin (`[[actions]]` of herdr-plugin.toml), as
// wherdr offers it: in an agent's menu (workspace/tab/pane contexts,
// run with the agent's pane) or in its machine's menu (global context).
export interface PluginAction {
  plugin: string // plugin_id
  pluginName: string
  id: string // action_id (local au plugin)
  title: string
  label: string // title without the plugin name as prefix (menu grouped by plugin)
  description: string | null
  agent: boolean // offered in an agent's menu
  machine: boolean // offered in the machine's menu
  confirm: boolean // asks for confirmation (may change something)
  inHerdr: boolean // opens a pane or popup in Herdr, not in wherdr
}
export interface PluginActionList { actions: PluginAction[] }
// Result of an action: Herdr runs it in the background, we wait a while for it to finish.
export interface PluginActionResult {
  status: 'succeeded' | 'failed' | 'running'
  exitCode: number | null
  output: string // end of the output (stdout, otherwise stderr), short
  // herdr-projects "Check setup": what wherdr uses, then the full output.
  setup?: { key: 'version' | 'binary' | 'home' | 'config', value: string, warn?: boolean }[]
  full?: string
}

// Read-only file browser of an agent's folder (Git root, or the folder itself).
export interface FileEntry { name: string, kind: 'dir' | 'file' | 'other', size: number | null, link: boolean }
export interface FilesListing { root: string, path: string, entries: FileEntry[], truncated: boolean }
export interface FilePreview {
  path: string
  size: number
  kind: 'text' | 'image' | 'pdf' | 'video' | 'binary' | 'large'
  text?: string
  dataUrl?: string
  truncated: boolean
}
