import { cspForHtml, tailnetImageSources } from '../utils/csp'
import { setTailnetSelf, tailnetDomainHosts } from '../utils/hosts'
import { onTailnetName } from '../utils/phone'

export default defineNitroPlugin((nitroApp) => {
  onTailnetName(setTailnetSelf)
  nitroApp.hooks.hook('render:response', (response, context) => {
    if (typeof response.body !== 'string' || !response.body.includes('<html')) return
    const csp = cspForHtml(response.body, context.event.node.req.headers.host || '', tailnetImageSources(tailnetDomainHosts()))
    response.headers = { ...response.headers, 'content-security-policy': csp }
  })
})
