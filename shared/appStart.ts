// How this device opens the app (Settings › Phone), read by the service worker
// before it answers a navigation, so it lives in Cache Storage: the worker has
// no localStorage. One entry in its own cache, which the worker's activate
// step keeps (app/service-worker/sw.ts).
// - 'network' (default): the server's current build, the cached shell past 3 s.
// - 'cache': the cached shell at once; the Reload banner announces a newer build.
export type AppStart = 'network' | 'cache'
export const APP_START_DEFAULT: AppStart = 'network'
export const APP_START_CACHE = 'wherdr-device'
const KEY = '/__wherdr/app-start'

export async function readAppStart(storage: CacheStorage): Promise<AppStart> {
  try {
    const hit = await (await storage.open(APP_START_CACHE)).match(KEY)
    return (await hit?.text()) === 'cache' ? 'cache' : APP_START_DEFAULT
  } catch { return APP_START_DEFAULT }
}

export async function writeAppStart(storage: CacheStorage, value: AppStart): Promise<void> {
  await (await storage.open(APP_START_CACHE)).put(KEY, new Response(value))
}
