// The named proxies (passwords masked) and the last choice of each machine.
import { proxiesView } from '../utils/proxies'

export default defineApi(async () => proxiesView())
