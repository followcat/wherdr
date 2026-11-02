// Herdr harvests history by scrolling an idle agent only in the alternate
// screen with mouse capture, for recent/recent_unwrapped text reads requesting
// more lines than the screen height. Visible snapshots never scroll the agent.
export async function readPassiveScreen(
  call: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<{ read?: { text?: unknown } }>,
  paneId: string,
): Promise<string> {
  const r = await call('pane.read', { pane_id: paneId, source: 'visible' }, 4000)
  return String(r?.read?.text || '')
}
