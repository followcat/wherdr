// The whole list at once (add, edit, delete and reorder come as the new
// list). A url sent back with the ••• mask keeps the stored password.
import { proxiesView, saveProxies } from '../utils/proxies'

export default defineApi(async (_event, body) => {
  await saveProxies(body.proxies)
  return proxiesView()
})
