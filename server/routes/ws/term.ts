// WS /ws/term?pane=…&cols=…&rows=…[&takeover=1]: terminal stream of the pane
// (see coreTerm.ts). An open stream keeps a task's agent from its release,
// what is typed in it counts as the user's message to it (pmTalk.ts).
import { streamOpen, userWrote } from '../../utils/pmTalk'
import { coreForPane } from '../../utils/state'

const sessions = new Map<string, TermSession>()
const addresses = new Map<string, string>()

export default defineWebSocketHandler({
  upgrade: request => checkUpgrade(request),
  open(peer) {
    watchPeer(peer)
    const url = new URL(peer.request?.url || '/', 'http://x')
    const ws = {
      // The relay picks per frame whether to deflate (coreTerm.ts,
      // termSendOptions): a repaint is worth zlib, a keystroke echo is not.
      send: (d: string, options?: { compress?: boolean }) => peer.send(d, options),
      close: (code?: number, reason?: string) => peer.close(code, reason),
      isOpen: () => isOpen(peer),
    }
    const paneId = url.searchParams.get('pane') || ''
    const entry = paneId ? coreForPane(paneId) : undefined
    const sess = entry ? openCoreTerm(ws, url, { endpoint: entry.endpoint, address: pane => findPane(pane)?.coreAddress, log }) : null
    if (!entry && paneId) ws.close(4404, 'Unknown session')
    if (sess) sessions.set(peer.id, sess)
    const address = sess && entry?.primary ? findPane(paneId)?.coreAddress : undefined
    if (address) { addresses.set(peer.id, address); streamOpen(address, 1) }
  },
  message(peer, message) {
    const raw = messageText(message)
    if (raw) sessions.get(peer.id)?.onMessage(raw)
    if (raw?.includes('"terminal.input"')) userWrote(addresses.get(peer.id))
  },
  close(peer, details) {
    unwatchPeer(peer)
    const s = sessions.get(peer.id)
    sessions.delete(peer.id)
    streamOpen(addresses.get(peer.id), -1)
    addresses.delete(peer.id)
    // 1000: the client closed its terminal (anything else: the connection dropped).
    s?.onClose(details?.code === 1000)
  },
})
