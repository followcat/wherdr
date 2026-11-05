// Current time, ticking once a second while the page is visible: a hidden
// page (phone in a pocket, another tab) wakes nothing up. It catches up at once
// when the page shows again.
import { pageVisible } from './useHerdr'

export function useSecondClock() {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  const run = (on: boolean) => {
    clearInterval(timer)
    timer = undefined
    if (!on) return
    now.value = Date.now()
    timer = setInterval(() => { now.value = Date.now() }, 1000)
  }
  onMounted(() => { watch(pageVisible, run, { immediate: true }) })
  onBeforeUnmount(() => { clearInterval(timer); timer = undefined })
  return now
}
