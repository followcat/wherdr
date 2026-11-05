// SettingsView sections, in one file: each component test file pays the first
// mount of the Nuxt app again.
import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import { useRouter } from '#app'
import SettingsView from '~/components/SettingsView.vue'
import ShortcutsSheet from '~/components/ShortcutsSheet.vue'
import ShortcutsReference from '~/components/ShortcutsReference.vue'
import { coarse, defaultViewMode, desk, encryptedText, reducedMotion, smoothTouchScrolling, typewriterSpeed, uiScale } from '~/composables/useHerdr'

const global = { stubs: { UTooltip: { template: '<span><slot /></span>' } } }
const original = {
  desk: desk.value, coarse: coarse.value, mode: defaultViewMode.value, smooth: smoothTouchScrolling.value,
  encrypted: encryptedText.value, motion: reducedMotion.value, speed: typewriterSpeed.value, scale: uiScale.value,
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
  uiScale.value = original.scale
  await nextTick()
  localStorage.removeItem('smoothTouchScrolling')
  localStorage.removeItem('uiScale')
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
    const rows = w.getComponent(ShortcutsReference).findAll('.shortcut-row')
    expect(rows).toHaveLength(18)
    // The hardware Alt+←/→ tab step is a supported v3 row, not filtered v2-only.
    const tabRow = rows.find(r => r.text().includes('tab of this space'))!
    expect(tabRow.find('dt').text()).toBe('Previous / next tab of this space')
    expect(tabRow.findAll('kbd').map(k => k.text())).toEqual(['Alt', '←', 'Alt', '→'])
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

it('Desktop: Interface size is a device choice, applied as data-ui-scale and kept on remount', async () => {
  desk.value = true
  uiScale.value = 'lg'
  const mount = () => mountSuspended(SettingsView, { route: '/settings?section=appearance', global })
  let w = await mount()
  const group = () => w.findAll('.settings-group').find(g => g.text().includes('Interface size'))!
  try {
    expect(group().isVisible()).toBe(true)
    const radios = group().findAll('[role="radio"]')
    expect(radios).toHaveLength(2)
    // Nuxt UI renders each item's label/description next to the radio control.
    expect(group().text()).toContain('Standard')
    expect(group().text()).toContain('Large')
    expect(group().text()).toContain('Saved on this device')
    // Under Large the Content width copy says what still differs — the
    // terminal's fitted cap — while the reading column is 1500 px for both.
    const widthGroup = () => w.findAll('.settings-group').find(g => g.text().includes('Content width'))!
    expect(widthGroup().text()).toContain('1500 px')
    expect(widthGroup().text()).toContain('terminal fitted to 760 px')
    expect(widthGroup().text()).toContain('terminal fitted to 1100 px')
    await radios[0]!.trigger('click')
    expect(uiScale.value).toBe('md')
    expect(localStorage.getItem('uiScale')).toBe('md')
    expect(document.documentElement.dataset.uiScale).toBe('md')
    // Back at Standard the fitted caps are the column widths again.
    expect(widthGroup().text()).toContain('760 px column')
    expect(widthGroup().text()).toContain('Up to 1100 px')
    w.unmount()
    w = await mount()
    expect(group().findAll('[role="radio"]')[0]!.attributes('aria-checked')).toBe('true')
    expect(localStorage.getItem('uiScale')).toBe('md')
  } finally { w.unmount() }
})

it('hides Interface size outside the computer layout', async () => {
  desk.value = false
  const w = await mountSuspended(SettingsView, { route: '/settings?section=appearance', global })
  try {
    expect(w.findAll('.settings-group').some(g => g.text().includes('Interface size'))).toBe(false)
    expect(w.findAll('.settings-group').some(g => g.text().includes('Content width'))).toBe(false)
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
