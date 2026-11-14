import { coreAdminDeps } from '../utils/coreAdminDeps'
import { coreMachineConfigs, homeOf, kindsOf } from '../utils/coreCreate'
import type { AppConfig } from '../../shared/types'
import { openNetworkMode } from '../utils/network'
import { publiclyExposed } from '../utils/chatFiles'
import { localMachineLabel } from '../utils/machines'

export default defineApi(async (): Promise<AppConfig> => {
  const deps = coreAdminDeps()
  const local = deps.machines().find(m => m.local)
  const [kinds, home, machines] = await Promise.all([
    kindsOf(deps).catch(() => []), homeOf(deps).catch(() => ''), coreMachineConfigs(deps).catch(() => undefined),
  ])
  return { hostLabel: localMachineLabel(), kinds, home, dirs: local ? await deps.recent(local) : [], machines, push: { enabled: pushReady(), key: vapidPublicKey(), devices: (await readSubs()).length }, openNetwork: openNetworkMode(), publicExposure: publiclyExposed() }
})
