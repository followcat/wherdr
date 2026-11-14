// The policy for files written in a conversation (shared/chatFiles.ts): the
// saved choice, else the default for how wherdr is exposed right now.
import { chatFilesLevel, type ChatFilesPolicy } from '../../shared/chatFiles'
import { netContext, openNetworkMode } from './network'
import { readSettings } from './settings'

// Reachable from the Internet: every network accepted, or Tailscale Funnel
// seen exposing wherdr's port (server/utils/network.ts).
export function publiclyExposed(): boolean {
  const ctx = netContext()
  return openNetworkMode() || Boolean(ctx.funnelExposed || ctx.tailscale?.funnel)
}

export async function chatFilesPolicy(): Promise<ChatFilesPolicy> {
  const s = await readSettings()
  return { level: chatFilesLevel(s.chatFilesLevel, publiclyExposed()), protected: s.chatFilesProtected === '1' }
}
