// SettingsView sections, in one file: each component test file pays the first
// mount of the Nuxt app again.
import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import { useRouter } from '#app'
import SettingsView from '~/components/SettingsView.vue'
import ShortcutsSheet from '~/components/ShortcutsSheet.vue'
import ShortcutsReference from '~/components/ShortcutsReference.vue'
import { coarse, defaultViewMode, desk, encryptedText, reducedMotion, smoothTouchScrolling, typewriterSpeed } from '~/composables/useHerdr'

const global = { stubs: { UTooltip: { template: '<span><slot /></span>' } } }
const original = {
  desk: desk.value, coarse: coarse.value, mode: defaultViewMode.value, smooth: smoothTouchScrolling.value,
  encrypted: encryptedText.value, motion: reducedMotion.value, speed: typewriterSpeed.value,
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  desk.value = original.desk
  coarse.value = original.coarse
  defaultViewMode.value = original.mode
  encryptedText.value = original.encrypted
  reducedMotion.value = original.motion
  typewriterSpeed.value = original.speed
  smoothTouchScrolling.value = original.smooth
  await nextTick()
  localStorage.removeItem('smoothTouchScrolling')
})

for (const device of ['desktop', 'phone', 'tablet']) {
  it(`offers the shared pane preference in Conversation on ${device}`, async () => {
    desk.value = device !== 'phone'
    coarse.value = device !== 'desktop'
    defaultViewMode.value = 'chat'
    const router = useRouter()
    if (device === 'phone') {
      // Exercise a direct entry: Settings inserts Home underneath on mount.
      history.replaceState({ ...history.state, back: null }, '')
    }
    const w = await mountSuspended(SettingsView, { route: '/settings?section=conversation', global })
    try {
      if (device === 'phone') {
        // mountSuspended does not await async onMounted hooks. Wait for both
        // replace('/') and push(here) before assertions or tearing down the DOM.
        await vi.waitFor(() => {
          expect(router.currentRoute.value.fullPath).toBe('/settings?section=conversation')
          expect(history.state.back).toBe('/')
        })
      }
      const group = w.findAll('.settings-group').find(g => g.text().includes('Default pane view'))!
      expect(group.isVisible()).toBe(true)
      await group.findAll('[role="radio"]')[1]!.trigger('click')
      expect(defaultViewMode.value).toBe('term')
      const nav = w.get('.settings-nav')
      expect(nav.text()).not.toContain('Desktop')
      expect(nav.text().includes('Shortcuts')).toBe(device === 'desktop')
    } finally { w.unmount() }
  })
}

it('shows the same reference component in Settings and the shortcut sheet', async () => {
  desk.value = true
  coarse.value = false
  const w = await mountSuspended(SettingsView, { route: '/settings?section=shortcuts', global })
  const sheet = await mountSuspended(ShortcutsSheet, { global: { stubs: { AppSheet: { template: '<div><slot /></div>' } } } })
  try {
    expect(w.getComponent(ShortcutsReference).isVisible()).toBe(true)
    expect(w.getComponent(ShortcutsReference).findAll('.shortcut-row')).toHaveLength(17)
    expect(sheet.findComponent(ShortcutsReference).exists()).toBe(true)
  } finally { w.unmount(); sheet.unmount() }
})

it('redirects the former Desktop query to Conversation', async () => {
  desk.value = true
  const router = useRouter()
  const w = await mountSuspended(SettingsView, { route: '/settings?section=desktop', global })
  try {
    // The desktop layout can render a fallback before the redirect finishes.
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/settings?section=conversation'))
    await vi.waitFor(() => expect(w.findAll('.settings-group').find(g => g.text().includes('Default pane view'))!.isVisible()).toBe(true))
  } finally { w.unmount() }
})

it('Terminal: smooth touch scrolling defaults to off and the switch persists across remounts', async () => {
  expect(smoothTouchScrolling.value).toBe(false)
  const mount = () => mountSuspended(SettingsView, { route: '/settings?section=terminal', global })
  let w = await mount()
  const row = () => w.findAll('.settings-toggle').find(r => r.text().includes('Smooth touch scrolling (beta)'))!
  try {
    expect(row().text()).toContain('Experimental')
    expect(row().get('[role="switch"]').attributes('aria-checked')).toBe('false')
    await row().get('[role="switch"]').trigger('click')
    expect(localStorage.getItem('smoothTouchScrolling')).toBe('1')
    w.unmount()
    w = await mount()
    expect(row().get('[role="switch"]').attributes('aria-checked')).toBe('true')
    await row().get('[role="switch"]').trigger('click')
    expect(localStorage.getItem('smoothTouchScrolling')).toBe('0')
  } finally { w.unmount() }
})

it('Conversation: replays the encrypted preview from glyphs to the complete plain reply when enabled', async () => {
  desk.value = true
  reducedMotion.value = false
  typewriterSpeed.value = 'slow'
  encryptedText.value = true
  // Control animation frames without faking the timers Nuxt needs to mount.
  let frame: FrameRequestCallback | undefined
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined })
  const w = await mountSuspended(SettingsView, { route: '/settings?section=conversation', global })
  try {
    const toggle = w.find('.encrypted-toggle [role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    // Finish the initial preview so this check requires the setting to replay it.
    now += 30_000
    frame?.(now)
    await nextTick()
    now += 1
    await toggle.trigger('click')
    expect(toggle.attributes('aria-checked')).toBe('false')
    now += 1
    await toggle.trigger('click')
    expect(toggle.attributes('aria-checked')).toBe('true')
    now += 1000
    frame?.(now)
    await nextTick()
    const preview = w.find('.typing-sample')
    const glyphs = preview.findAll('.tw-trail [data-g]')
    expect(glyphs.length).toBeGreaterThan(0)
    expect(glyphs[0]!.attributes('data-g')).toMatch(/^\S$/u)
    now += 30_000
    frame?.(now)
    await nextTick()
    expect(preview.findAll('.tw-trail [data-g]')).toHaveLength(0)
    expect(preview.text()).toContain('Found the cause: the cache was never invalidated after an update.')
    expect(preview.text()).toContain('All tests pass.')
  } finally { w.unmount() }
})
