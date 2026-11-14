// Which files a path written in a conversation may open (Settings › Security ›
// Files shown from conversations). wherdr runs as the machine's user: Unix
// permissions apply at every level, and the protected paths
// (server/utils/files.ts) stay hidden unless `chatFilesProtected` is on.
//
// all: every file the user can read; temp: the home folder and the agents'
// temporary folders; home: the home folder only. With no choice saved:
// everything while wherdr answers only this computer and the tailnet, the
// home and temporary folders once it is publicly exposed (Tailscale Funnel,
// WHERDR_TRUSTED_NETWORKS=any).

export const CHAT_FILES_LEVELS = ['all', 'temp', 'home'] as const
export type ChatFilesLevel = typeof CHAT_FILES_LEVELS[number]
export interface ChatFilesPolicy { level: ChatFilesLevel, protected: boolean }

// Where agents leave temporary files: /tmp (Linux, Claude's scratchpad),
// /var/folders ($TMPDIR on macOS), /var/tmp; /private/… is their macOS target.
export const TEMP_ROOTS = ['/tmp', '/var/tmp', '/var/folders', '/private/tmp', '/private/var/tmp', '/private/var/folders']

export const isChatFilesLevel = (v: unknown): v is ChatFilesLevel => (CHAT_FILES_LEVELS as readonly unknown[]).includes(v)

export function chatFilesLevel(saved: string | null | undefined, exposed: boolean): ChatFilesLevel {
  if (isChatFilesLevel(saved)) return saved
  return exposed ? 'temp' : 'all'
}

// The folders a written path must lie in, in order of preference.
export function chatFilesRoots(home: string, level: ChatFilesLevel): string[] {
  if (level === 'all') return ['/']
  return level === 'temp' ? [home, ...TEMP_ROOTS] : [home]
}
