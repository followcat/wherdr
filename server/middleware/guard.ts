// Every request goes through gateDecision (server/utils/network.ts): first
// where it comes from (this computer, the tailnet, WHERDR_TRUSTED_NETWORKS),
// then the Host header, cross-site API reads, and, once a passkey is set up,
// the lock for everything touching agents (API, images, photos). The app's files are still served so the lock screen can
// be shown. (WebSockets go through the same decision in their `upgrade`.)
// An authenticated request upgrades a cookie from an earlier version (auth.renew).
import type { H3Event } from 'h3'
import { crossSiteRequest, hostAllowed, hostRefusalIsHtml, hostRefusedPage, networkRefusedPage } from '../utils/hosts'
import { checkRequestClient, cliTokenCall, ensureRecent, gateDecision, networkReady } from '../utils/network'
import { coreRouteAllowed } from '../../shared/coreRoutes'
import { SHOT_TOKEN_HEADER } from '../../shared/pm/shots'
import { adoptServed } from '../utils/phone'
const HOST_RECHECK_MS = 3000
const HTTP_FRESH_MS = 2000
const HTTP_BLOCK_MS = 10_000

function htmlRefusal(event: H3Event, page: string) {
  setResponseStatus(event, 403)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'no-store')
  return page
}

export default defineEventHandler(async (event) => {
  await networkReady()
  // Tailscale read again past 2 s (Funnel may have been turned on since): in the
  // background, the request waiting only when the reading is over 10 s old.
  await ensureRecent(HTTP_FRESH_MS, HTTP_BLOCK_MS)
  const path = event.path.split('?')[0]!
  const headers = event.node.req.headers
  const check = checkRequestClient(event.node.req.socket?.remoteAddress, headers, auth.isEnabled())
  // An unknown host: maybe an address `tailscale serve` just published. The
  // request only triggers reading Tailscale again (at most every few
  // seconds); its Host header is never what gets allowed.
  if (check.ok && !hostAllowed(headers.host)) await adoptServed(HOST_RECHECK_MS)
  const req = reqOf(event)
  const verdict = gateDecision({
    check, path,
    unlocked: auth.isUnlocked(req) || cliTokenCall(path, check, headers.authorization),
    hostOk: hostAllowed(headers.host),
    crossSite: crossSiteRequest(headers),
    agentKey: event.method === 'POST' && typeof headers[SHOT_TOKEN_HEADER] === 'string',
  })
  const html = hostRefusalIsHtml(path, headers.accept)
  switch (verdict) {
    case 'network': {
      const why = !check.ok && (check.reason === 'funnel' || check.reason === 'foreign') ? check.reason : undefined
      if (html) return htmlRefusal(event, networkRefusedPage(why))
      const error = why === 'funnel'
        ? 'Tailscale Funnel exposes wherdr to the Internet: turn it off for wherdr\'s port'
        : why === 'foreign'
          ? 'This tailnet device is not one of the owner\'s: wherdr admits it only once a passkey is set up'
          : 'wherdr only answers this computer and your tailnet'
      return sendError(event, 403, { error, code: 'network', ...(why ? { why } : {}) })
    }
    case 'host':
      if (html) return htmlRefusal(event, hostRefusedPage(undefined, headers.host))
      return sendError(event, 403, { error: 'Host not allowed', code: 'host' })
    case 'origin':
      return sendError(event, 403, { error: 'Origin refused', code: 'origin' })
    case 'locked':
      return sendError(event, 401, { error: 'App is locked', code: 'locked' })
  }
  if (path.startsWith('/api/') && !coreRouteAllowed(path, event.method)) {
    return sendError(event, 503, { error: 'Unavailable with herdr-core' })
  }
  const renewed = auth.renew(req)
  if (renewed) appendResponseHeader(event, 'set-cookie', renewed.cookie)
})
