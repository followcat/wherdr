import { internalBack, isDetailRoute } from '~/utils/viewHistory'

export default defineNuxtPlugin((app) => {
  const router = useRouter()
  // Search is a sheet: returning restores the screen that hosted it.
  let home: { machine: string | null, scroll: number } | undefined
  let hashEntry: { from: string, to: string } | undefined
  function onPop(event: PopStateEvent) {
    // A new native hash link has no router state. Entries already visited by
    // this app do: leave their back/forward metadata alone on history pops.
    hashEntry = !desk.value && event.state === null ? {
      from: router.currentRoute.value.fullPath,
      to: router.resolve(location.hash.slice(1) || '/').fullPath,
    } : undefined
  }
  router.beforeEach((to, from) => {
    if (!desk.value && from.path === '/' && to.path !== '/') {
      home = { machine: machineBarPick.value, scroll: document.querySelector('#home .scroll')?.scrollTop ?? 0 }
    }
  })
  router.afterEach(async (to, from, failure) => {
    const entry = hashEntry
    hashEntry = undefined
    if (!failure && entry?.to === to.fullPath && entry.from === from.fullPath) {
      // Vue Router normalizes a native hash entry with a null `back`. Keep its
      // actual in-app predecessor so header back traverses rather than replaces.
      router.options.history.replace(to.fullPath, { back: from.fullPath })
    }
    if (desk.value || to.path !== '/' || !home) return
    if (home.machine !== null) pickMachineBar(home.machine)
    await nextTick()
    document.querySelector('#home .scroll')?.scrollTo({ top: home.scroll })
  })
  app.hook('app:mounted', () => {
    // Capture the predecessor before Vue Router handles this native entry.
    window.addEventListener('popstate', onPop, { capture: true })
    const router = useRouter()
    const route = router.currentRoute.value
    if (desk.value || !isDetailRoute(route.path, route.query) || internalBack(history.state?.back)) return
    // A cold notification or direct link has no app screen behind it. Put Home
    // underneath the detail once, including on reload. Use RouterHistory so its
    // position/back/forward bookkeeping stays consistent with native iOS/Android
    // back gestures, without rendering an intermediate screen or adding a loop.
    router.options.history.replace('/')
    router.options.history.push(route.fullPath)
  })
})
