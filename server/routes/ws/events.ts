import { notificationPresence } from '../../utils/notificationRules'
// WS /ws/events: the agents' state, pushed on every change. The app says
// which agent is on screen: no notification for that one.
export default defineWebSocketHandler({
  upgrade: request => checkUpgrade(request),
  open(peer) {
    watchPeer(peer)
    eventClients.set(peer.id, { send: d => isOpen(peer) && peer.send(d), pane: null, visible: false })
    peer.send(getStateJson())
  },
  message(peer, message) {
    const raw = messageText(message)
    if (!raw) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let m: any
    try { m = JSON.parse(raw) }
    catch { return }
    if (m && m.type === 'ping') { peer.send(JSON.stringify({ type: 'pong' })); return }
    const c = eventClients.get(peer.id)
    if (c && m && m.type === 'viewing') {
      c.pane = PANE_RE.test(m.pane || '') ? m.pane : null
      c.visible = m.visible === true
      notificationPresence.heartbeat(peer.id, c.pane, c.visible)
    }
  },
  close(peer) {
    unwatchPeer(peer)
    eventClients.delete(peer.id)
  },
})
